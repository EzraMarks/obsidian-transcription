import { TFile, Vault, App } from "obsidian";
import Fuse from "fuse.js";
import { TranscriptionSettings } from "src/settings";
import { StatusBar } from "../status";
import { BacklinkEngine, BacklinkEntry, BacklinksArrayDict } from "./backlinkEngine";
import { UtilsEngine } from "./utilsEngine";
import { extractSentence, findNearestHeading } from "../utils";
import { ResolveEntityModal } from "src/resolveEntityModal";

export interface AiExtractEntitiesResponse {
    [canonicalName: string]: {
        occurrences: EntityOccurrence[];
    };
}

/** One sentence in which the entity appears */
export interface EntityOccurrence {
    header: string | null | undefined;
    displayName: string;
    sentence: string;
}

/** A single proper-noun (grouped across variants) and all its mentions */
export interface ExtractedEntity {
    canonicalName: string;
    occurrences: EntityOccurrence[];
}

/** Enriched Obsidian file */
export interface EnrichedFile {
    file: TFile;
    aliases: string[];
    misspellings: string[];
}

export interface NewFile {
    baseName: string;
    aliases?: string[];
    misspellings?: string[];
}

/** A candidate match between an ExtractedEntity and a file */
export interface FileCandidate {
    /** The file */
    enrichedFile: EnrichedFile;
    /** Fuzzy‑match score (0–1 where 0 is exact match) */
    nameMatchScore: number;
}

export interface EnrichedFileCandidate extends FileCandidate {
    /** Total number of references to this file */
    backlinkCount: number;
    /** Age in days of the most recent edit on any file that links to this file; proxy for the last time this file was referenced */
    daysSinceLastBacklinkEdit: number;
    /** A few examples of the context in which this file has been previously referenced */
    sampleOccurrences: EntityOccurrence[];
    /** The first few lines of the file contents */
    bodyPreview: string;
}

/** All matching file candidates for one entity */
export interface ExtractedEntityWithFileCandidates {
    /** The extracted entity */
    entity: ExtractedEntity;
    /** List of possible file matches */
    candidates: FileCandidate[];
}

/** The extracted entity being matched and the chosen file */
export interface EntityFileSelection {
    entityWithFileCandidates: ExtractedEntityWithFileCandidates;
    selectedFile?: EnrichedFile;
    newFile?: NewFile;
    wasManuallyResolved?: boolean;
}

export class AutoWikilinkEngine {
    private readonly utilsEngine: UtilsEngine;
    private readonly backlinkEngine: BacklinkEngine;

    constructor(
        private readonly settings: TranscriptionSettings,
        private readonly vault: Vault,
        private readonly statusBar: StatusBar | null,
        private readonly app: App,
    ) {
        this.utilsEngine = new UtilsEngine(settings, vault, app);
        this.backlinkEngine = new BacklinkEngine(settings, vault, app, this.utilsEngine);
    }

    /** Main entry point: applies auto-wikilinks to the given text */
    async applyAutoWikilink(input: string, files: TFile[]): Promise<string> {
        // Tag entities in text via LLM
        const taggedText = await this.generateTaggedText(input);

        console.log("Tagged text", taggedText);

        // Extract entities from the tagged text
        const extractedEntities = this.parseTaggedEntitiesFromText(taggedText);

        // Find fuzzy-match candidates
        const enrichedFiles: EnrichedFile[] = files.map((file) => {
            const aliases = this.app.metadataCache.getFileCache(file)?.frontmatter?.["aliases"];
            const misspellings = this.app.metadataCache.getFileCache(file)?.frontmatter?.["misspellings"];

            return {
                file: file,
                aliases: Array.isArray(aliases) ? aliases : aliases ? [aliases] : [],
                misspellings: Array.isArray(misspellings) ? misspellings : misspellings ? [misspellings] : [],
            };
        });

        const extractedEntitiesWithFileCandidates: ExtractedEntityWithFileCandidates[] = await Promise.all(
            extractedEntities.map(async (entity) => {
                const candidates = await this.getFileCandidates(entity, enrichedFiles);
                return { entity, candidates };
            }),
        );

        console.log("File candidates", extractedEntitiesWithFileCandidates);

        // AI selects best candidate
        const selections: EntityFileSelection[] = await Promise.all(
            extractedEntitiesWithFileCandidates.map(async (item) => {
                const selectedFile = item.candidates.length ? await this.selectBestCandidate(item) : undefined;
                return { entityWithFileCandidates: item, selectedFile };
            }),
        );

        console.log("Selections", selections);
        console.log(
            "Selections (but readable)",
            JSON.stringify(
                selections.map((it) => ({
                    entity: it.entityWithFileCandidates.entity.canonicalName,
                    fileChoice: it.selectedFile?.file.path,
                })),
                null,
                2,
            ),
        );

        // Human resolve unresolved
        const finalSelections = await new Promise<EntityFileSelection[]>((resolve) => {
            new ResolveEntityModal(this.app, selections, enrichedFiles, resolve).open();
        });

        console.log(
            "Final selections (but readable)",
            JSON.stringify(
                finalSelections.map((it) => ({
                    entity: it.entityWithFileCandidates.entity.canonicalName,
                    fileChoice: it.selectedFile?.file.path,
                })),
                null,
                2,
            ),
        );

        // Replace text with links
        const output = this.applyLinksToText(taggedText, finalSelections);
        return output;
    }

    // TODO: Filter out entries that are within headers

    /**
     * Tag entities in the text with <entity id="Canonical Name">...</entity>
     */
    async generateTaggedText(input: string): Promise<string> {
        const systemPrompt = `
        You are an entity-tagging assistant with strong coreference resolution.
        Your task is to insert <entity> tags around every mention of a person's name in markdown text.

        Instructions:
        1. Identify every reference to a person's name (first, last, or full).
        2. Wrap each mention with <entity> tags and add an \`id\` attribute set to that person's **most complete name** mentioned anywhere in the text.
        - Example: I recently read <entity id="The Great Gatsby">Gatsby</entity> by <entity id="F. Scott Fitzgerald">Fitzgerald</entity>.
        3. Use semantic context and coreference to group different surface forms (e.g., "Gatsby" = "The Great Gatsby").
        4. If the **same surface form** refers to **different people** in different parts of the text, treat them as different entities.
        5. Do not tag pronouns, e.g., "she"/"he"/"the person"
        6. Preserve the original text exactly, modifying it only by inserting <entity id="...">Name</entity> tags.

        Output only the modified text with <entity> tags.
        `.trim();

        const userPrompt = `
        Tag every mention of a person's name in the following text, without tagging pronouns like he/she/they.

        ${input}
        `;

        const response = await this.utilsEngine.callOpenAI({
            systemPrompt,
            userPrompt,
            temperature: 0,
        });

        return response;
    }

    parseTaggedEntitiesFromText(taggedText: string): ExtractedEntity[] {
        const entityRegex = /<entity id="(.*?)">(.*?)<\/entity>/g;
        const lines = taggedText.split(/\r?\n/);

        const entities: Map<string, ExtractedEntity> = new Map();
        let currentHeader: string | undefined = undefined;

        for (const line of lines) {
            const headerMatch = line.match(/^#+ (.+)$/);
            if (headerMatch) {
                currentHeader = headerMatch[1].trim();
            }

            // If this line is a markdown header, skip entity extraction for this line
            if (/^#+ /.test(line)) {
                continue;
            }

            let match;
            while ((match = entityRegex.exec(line)) !== null) {
                const [fullMatch, canonicalName, rawText] = match;
                const col = match.index;

                const extractedSentence = extractSentence(line, col);
                const redactedSentence = this.redactTranscriptionTextForLlm(extractedSentence, fullMatch);

                const occurrence: EntityOccurrence = {
                    header: currentHeader,
                    displayName: rawText,
                    sentence: redactedSentence,
                };

                if (!entities.has(canonicalName)) {
                    entities.set(canonicalName, {
                        canonicalName: canonicalName,
                        occurrences: [],
                    });
                }

                entities.get(canonicalName)!.occurrences.push(occurrence);
            }
        }

        return Array.from(entities.values());
    }

    // TODO: I should be caching, for every file that is to become a file candidate, the full FileCandidate result!
    // Really I should have a FileCandidate object and an EnrichedFileCandidate object, and that way I can...
    // - quickly gather all the ExtractedEntityWithFileCandidates
    // - from that object, derive a deduplicated list of all file candidates
    // - then make a map from FileCandidate to EnrichedFileCandidate,
    // - then, using the hashmap, make the ExtractedEntityWithEnrichedFileCandidates

    /** Returns fuzzy-matched file candidates for an entity */
    private async getFileCandidates(entity: ExtractedEntity, files: EnrichedFile[]): Promise<FileCandidate[]> {
        const fuse = new Fuse(files, {
            keys: ["file.basename", "aliases", "misspellings"], // TODO: Add misspellings frontmatter to my documents...
            threshold: 0.25,
            includeScore: true,
            useExtendedSearch: true,
        });

        // Extract all variants of the entity from its occurrences
        const entityVariants = new Set(entity.occurrences.map((item) => item.displayName));

        const results = fuse.search(Array.from(entityVariants).join("|"));
        const fileCandidatePromises = results.map(async (r): Promise<FileCandidate> => {
            const enrichedFile = r.item;
            if (r.score === undefined) throw new Error("Fuzzy match score is undefined");
            const nameMatchScore: number = 1 - r.score;

            return { enrichedFile, nameMatchScore };
        });

        const fileCandidates = await Promise.all(fileCandidatePromises);
        return fileCandidates.filter((c): c is FileCandidate => c != undefined);
    }

    /** Retrieves a few examples of the context in which this file has been previously referenced */
    private async getSampleEntityOccurrences(backlinks: BacklinksArrayDict): Promise<EntityOccurrence[]> {
        const backlinkEntries = this.backlinkEngine.getRandomRecentBacklinkEntries(backlinks, 3); // TODO: Add sample size to settings
        const entityOccurrences: (EntityOccurrence | undefined)[] = await Promise.all(
            backlinkEntries.map((it) => this.getEntityOccurrence(it)),
        );
        return entityOccurrences.filter((it): it is EntityOccurrence => it != undefined);
    }

    private async getEntityOccurrence(backlinkEntry: BacklinkEntry): Promise<EntityOccurrence | undefined> {
        const { sourcePath, reference } = backlinkEntry;
        const file = this.utilsEngine.getFileOrThrow(sourcePath);
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split("\n");

        // only handle in-body links with position data
        if ("position" in reference && reference.position) {
            const { line: lineNum, col } = reference.position.start;
            const lineText = lines[lineNum] || "";

            const header = findNearestHeading(lines, lineNum);
            const extractedSentence = extractSentence(lineText, col).trim();
            const redactedSentence = this.redactVaultTextForLlm(extractedSentence, backlinkEntry.reference.original);

            return {
                header: header,
                displayName: backlinkEntry.reference.displayText ?? backlinkEntry.reference.link,
                sentence: redactedSentence,
            };
        }

        return undefined;
    }

    /** Gets the first few lines of the file contents */
    private async getBodyPreview(file: TFile): Promise<string> {
        const content = await this.vault.cachedRead(file);

        // Strip YAML frontmatter if present
        const body = content.replace(/^---\s*[\s\S]*?\n---\s*/, "").trimStart();

        const preview = content.length <= 400 ? content : content.slice(0, 400) + "...";
        return preview;
    }

    /** AI selects best candidate or undefined */
    private async selectBestCandidate(item: ExtractedEntityWithFileCandidates): Promise<EnrichedFile | undefined> {
        const enrichedCandidates: EnrichedFileCandidate[] = await Promise.all(
            item.candidates.map(async (fileCandidate) => {
                const backlinks = this.backlinkEngine.getBacklinksForFile(fileCandidate.enrichedFile.file);
                const backlinkCount = this.backlinkEngine.calculateBacklinkCount(backlinks);
                const daysSinceLastBacklinkEdit = this.backlinkEngine.calculateDaysSinceLastBacklinkEdit(backlinks);

                const sampleOccurrences = await this.getSampleEntityOccurrences(backlinks);
                const bodyPreview = await this.getBodyPreview(fileCandidate.enrichedFile.file);

                return {
                    ...fileCandidate,
                    backlinkCount,
                    daysSinceLastBacklinkEdit,
                    sampleOccurrences,
                    bodyPreview,
                };
            }),
        );

        const candidatesForLlm = enrichedCandidates.map((it) => {
            return {
                filePath: it.enrichedFile.file.path,
                popularity: it.backlinkCount,
                daysSinceLastReferenced: it.daysSinceLastBacklinkEdit,
                bodyPreview: it.bodyPreview,
                sampleOccurrences: it.sampleOccurrences.map((sampleOccurrence) => ({
                    header: sampleOccurrence.header,
                    sentence: sampleOccurrence.sentence,
                })),
            };
        });

        const occurrencesForLlm = item.entity.occurrences.map((occurrence) => ({
            header: occurrence.header,
            sentence: occurrence.sentence,
        }));

        // TODO: Make it so this prompt just returns a numreical score value

        // TODO: Need to take into account nameMatchScore more!

        // TODO: Improve this prompt
        const systemPrompt = `You are an entity-to-file resolver.
        Given:
         - An entity, including the context of where that name appears in the current text
         - A list of candidate files, including contexts in which that name has appeared in the past
        Your job is to pick the one file which is the most likely match for the entity in question. Also take note
        of the popularity (higher is better) and daysSinceLastReferenced (lower is better) of the candidate, which should be prioritized
        to maximize popularity and minimize daysSinceLastReferenced. Pay no attention to the spelling of the entities; it is not important.
        Reply with exactly one of:
         - The file's path (exact string, no quotes or extra text)
         - "undefined"
        If you are really unsure, reply "undefined", otherwise choose the best file.
        `;

        const userPrompt = `
        Occurrences in this text:
        ${JSON.stringify(occurrencesForLlm, null, 2)}

        
        Candidates:
        ${JSON.stringify(candidatesForLlm, null, 2)}

        Respond with only the file path or undefined.
        `;

        // console.log("Prompts are", systemPrompt, userPrompt); // TODO: Remove

        const raw = await this.utilsEngine.callOpenAI({ systemPrompt, userPrompt, model: "gpt-4o-mini" });

        // Parse out the first line, strip quotes/spaces
        const firstLine = raw.split(/\r?\n/)[0] || "";
        const filePath = firstLine.trim().replace(/^["']|["']$/g, "");

        if (!filePath || filePath === "undefined") {
            return undefined;
        }

        return item.candidates.find((c) => c.enrichedFile.file.path === filePath)?.enrichedFile;
    }

    private applyLinksToText(taggedText: string, selections: EntityFileSelection[]): string {
        const entityRegex = /<entity id="(.*?)">(.*?)<\/entity>/g;

        const entityToSelection = new Map<string, EntityFileSelection>();
        for (const sel of selections) {
            entityToSelection.set(sel.entityWithFileCandidates.entity.canonicalName, sel);

            if (sel.newFile) {
                this.createNewFile("", sel.newFile);
            }
        }

        const replaced = taggedText.replace(entityRegex, (fullMatch, canonicalName, surfaceText) => {
            const sel = entityToSelection.get(canonicalName);

            const targetName = sel?.selectedFile?.file.basename || sel?.newFile?.baseName;

            if (!targetName) {
                // No selection → just unwrap the <entity> and keep the surface text
                return surfaceText;
            }

            const displayNames = [targetName, ...(sel.selectedFile?.aliases ?? sel?.newFile?.aliases ?? [])];
            const misspellings = sel.selectedFile?.misspellings ?? sel?.newFile?.misspellings ?? [];
            const spellingHelper = this.buildSpellingHelper(misspellings, displayNames);

            // Perform spelling correction on the surface text
            const displayName = this.correctSpelling(sel, surfaceText, spellingHelper);

            return targetName === displayName ? `[[${targetName}]]` : `[[${targetName}|${displayName}]]`;
        });

        return replaced;
    }

    private buildSpellingHelper(
        misspellings: string[],
        displayNames: string[],
    ): { misspellingDetector: Fuse<string>; displayNameSuggester: Fuse<string> } {
        return {
            misspellingDetector: new Fuse(misspellings, { threshold: 0 }),
            displayNameSuggester: new Fuse(displayNames, {
                includeScore: true,
                shouldSort: true,
            }),
        };
    }

    private correctSpelling(
        fileSelection: EntityFileSelection,
        rawDisplayName: string,
        spellingHelper: { misspellingDetector: Fuse<string>; displayNameSuggester: Fuse<string> },
    ): string {
        const { misspellingDetector, displayNameSuggester } = spellingHelper;

        const isMisspelled = fileSelection.wasManuallyResolved || misspellingDetector.search(rawDisplayName).length > 0;
        const bestMatch = displayNameSuggester.search(rawDisplayName)?.[0];

        if (isMisspelled || (bestMatch?.score ?? 1) < 0.25) {
            return bestMatch?.item || rawDisplayName;
        }

        return rawDisplayName;
    }

    private async createNewFile(folderPath: string, fileData: NewFile): Promise<TFile> {
        const { baseName, aliases, misspellings } = fileData;
        const filePath = `${folderPath}/${baseName}.md`;

        // Format today's date as YYYY-MM-DD
        const today = new Date();
        const dateCreated = today.toISOString().split("T")[0]; // "2025-04-28" for example

        // Build YAML frontmatter
        const frontmatterLines = [
            "---",
            `date_created: ${dateCreated}`,
            ...(aliases ? [`aliases:\n${aliases.map((a) => `  - ${a}`).join("\n")}`] : []),
            ...(misspellings ? [`misspellings:\n${misspellings.map((m) => `  - ${m}`).join("\n")}`] : []),
            "---",
        ];
        const frontmatter = frontmatterLines.join("\n");

        // File content will start with frontmatter
        const content = `${frontmatter}\n\n`;

        // Create the file
        return await this.vault.create(filePath, content);
    }

    /**
     * Redacts a sentence from the vault by:
     * - Replacing the specific `targetBacklinkSubstring` (e.g. a wikilink like [[Bob Smith]]) with a neutral <entity/> tag.
     * - Removing all other Obsidian-style wikilinks by replacing them with their visible display name or target text.
     *
     * @param text - The full sentence text from the vault.
     * @param targetBacklinkSubstring - The exact substring to replace with <entity/>.
     * @returns A sanitized version of the text suitable for LLM input.
     */
    private redactVaultTextForLlm(text: string, targetBacklinkSubstring: string): string {
        const escapedTarget = targetBacklinkSubstring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const targetRegex = new RegExp(escapedTarget, "g");
        const redacted = text.replace(targetRegex, "<entity/>");

        const stripped = redacted.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
            const pipeIndex = content.indexOf("|");
            return pipeIndex !== -1 ? content.slice(pipeIndex + 1) : content;
        });

        return stripped;
    }

    /**
     * Redacts a sentence from the transcription output by:
     * - Replacing the exact `targetEntitySubstring` (e.g. <entity id="X">Bob</entity>) with <entity/>.
     * - Removing all other <entity>...</entity> tags and leaving their inner text intact.
     *
     * @param text - The sentence containing one or more <entity> tags.
     * @param targetEntitySubstring - The exact <entity>...</entity> span to replace with <entity/>.
     * @returns The redacted sentence with only the target entity anonymized.
     */
    private redactTranscriptionTextForLlm(text: string, targetEntitySubstring: string): string {
        const entityRegex = /<entity\b[^>]*>(.*?)<\/entity>/g;

        return text.replace(entityRegex, (fullMatch, innerText) => {
            if (fullMatch === targetEntitySubstring) {
                return "<entity/>";
            } else {
                return innerText;
            }
        });
    }
}
