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
    /** Fuzzy‑match score (0–1 where 1 is exact) */
    nameMatchScore: number;
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
        // Step 1: tag entities in text via LLM
        const taggedText = await this.generateTaggedText(input);

        console.log("Tagged text", taggedText);

        // Step 2: extract entities from the tagged text
        const extractedEntities = this.parseTaggedEntitiesFromText(taggedText);

        // Step 3: find fuzzy-match candidates
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

        // Step 4: AI selects best candidate
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

        // Step 5: human resolve unresolved
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

        // Step 6: replace text with links
        const output = this.applyLinksToText(taggedText, finalSelections);
        return output;
    }

    // TODO: Filter out entries that are within headers

    /**
     * Tag entities in the text with <entity id="Canonical Name">...</entity>
     */
    async generateTaggedText(input: string): Promise<string> {
        const systemPrompt = `
        You are an entity-tagging assistant with strong coreference resolution. Your task is to insert <entity> tags around every explicit mention of a person's name in markdown text.

        Instructions:
        1. Identify every unique **explicit** reference to a person's name (first, last, or full).
        2. Wrap each mention with <entity> tags and add an \`id\` attribute set to that person's **most complete name** mentioned anywhere in the text.
        - Example: I recently read <entity id="The Great Gatsby">Gatsby</entity> by <entity id="F. Scott Fitzgerald">Fitzgerald</entity>.
        3. Use semantic context and coreference to group different surface forms (e.g., "Gatsby" = "The Great Gatsby").
        4. If the **same surface form** refers to **different people** in different parts of the text, treat them as different entities.
        5. Do **not** tag pronouns or vague references (e.g., "she", "my cousin", "the man").
        6. Preserve the original text exactly, modifying it only by inserting <entity id="...">Name</entity> tags.

        Guidelines:
        - Only tag names of real or fictional people.
        - Use only names explicitly present or **strongly implied** by context.
        - The \`id\` should be the most complete and recognizable name mentioned for each person.
        - Tag each unique mention only where it appears in the text (no deduping or summaries).

        Output only the modified text with <entity> tags.
        `.trim();

        const response = await this.utilsEngine.callOpenAI({
            systemPrompt,
            userPrompt: input,
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

            let match;
            while ((match = entityRegex.exec(line)) !== null) {
                const [fullMatch, canonicalName, rawText] = match;
                const col = match.index;

                const occurrence: EntityOccurrence = {
                    header: currentHeader,
                    sentence: extractSentence(line, col),
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
            ignoreLocation: true,
            includeScore: true,
            useExtendedSearch: true,
        });

        // Extract all variants of the entity from its occurrences
        const entityVariants = new Set<string>();
        for (const occurrence of entity.occurrences) {
            const match = occurrence.sentence.match(/<entity\b[^>]*>(.*?)<\/entity>/);
            if (match && match[1]) {
                entityVariants.add(match[1]);
            }
        }

        const results = fuse.search(Array.from(entityVariants).join("|"));
        const fileCandidatePromises = results.map(async (r) => {
            const file = r.item;
            if (r.score === undefined) throw new Error("Fuzzy match score is undefined");
            const nameMatchScore: number = 1 - r.score;
            const backlinks = this.backlinkEngine.getBacklinksForFile(file.file);
            const backlinkCount = this.backlinkEngine.calculateBacklinkCount(backlinks);
            const daysSinceLastBacklinkEdit = this.backlinkEngine.calculateDaysSinceLastBacklinkEdit(backlinks);

            // TODO: Filtering criteria needs work
            if (daysSinceLastBacklinkEdit > 60 && backlinkCount < 100 && nameMatchScore < 0.5) {
                return undefined;
            }

            const sampleOccurrences = this.getSampleEntityOccurrences(backlinks);
            const bodyPreview = this.getBodyPreview(file.file);

            const fileCandidate: FileCandidate = {
                enrichedFile: file,
                nameMatchScore,
                backlinkCount,
                daysSinceLastBacklinkEdit,
                sampleOccurrences: await sampleOccurrences,
                bodyPreview: await bodyPreview,
            };

            return fileCandidate;
        });

        const fileCandidates = await Promise.all(fileCandidatePromises);
        return fileCandidates.filter((c): c is FileCandidate => c != undefined);
    }

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

            const sentence = extractSentence(lineText, col).trim();
            const header = findNearestHeading(lines, lineNum);

            return { header: header, sentence };
        }

        return undefined;
    }

    private async getBodyPreview(file: TFile): Promise<string> {
        const content = await this.vault.cachedRead(file);

        // Strip YAML frontmatter if present
        const body = content.replace(/^---\s*[\s\S]*?\n---\s*/, "").trimStart();

        const preview = content.length <= 400 ? content : content.slice(0, 400) + "...";
        return preview;
    }

    /** AI selects best candidate or undefined */
    private async selectBestCandidate(item: ExtractedEntityWithFileCandidates): Promise<EnrichedFile | undefined> {
        const candidates = item.candidates.map((it) => {
            return {
                filePath: it.enrichedFile.file.path,
                aliases: it.enrichedFile.aliases,
                misspellings: it.enrichedFile.misspellings,
                popularity: it.backlinkCount,
                daysSinceLastReferenced: it.daysSinceLastBacklinkEdit,
                bodyPreview: it.bodyPreview,
                sampleOccurrences: it.sampleOccurrences,
            };
        });

        // TODO: Make it so this prompt just returns a numreical score value

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
        Entity:
        ${JSON.stringify(item.entity, null, 2)}
        Candidates:
        ${JSON.stringify(candidates, null, 2)}

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

            const aliases = [targetName, ...(sel.selectedFile?.aliases ?? sel?.newFile?.aliases ?? [])];
            const misspellings = sel.selectedFile?.aliases ?? sel?.newFile?.aliases ?? [];
            const spellingHelper = this.buildSpellingHelper(misspellings, aliases);

            // Perform spelling correction on the surface text
            const alias = this.correctSpelling(sel, surfaceText, spellingHelper);

            return targetName === alias ? `[[${targetName}]]` : `[[${targetName}|${alias}]]`;
        });

        return replaced;
    }

    private buildSpellingHelper(
        misspellings: string[],
        aliases: string[],
    ): { misspellingDetector: Fuse<string>; aliasSuggester: Fuse<string> } {
        return {
            misspellingDetector: new Fuse(misspellings, { threshold: 0, ignoreLocation: true }),
            aliasSuggester: new Fuse(aliases, { includeScore: true, ignoreLocation: true, shouldSort: true }),
        };
    }

    private correctSpelling(
        fileSelection: EntityFileSelection,
        rawAlias: string,
        spellingHelper: { misspellingDetector: Fuse<string>; aliasSuggester: Fuse<string> },
    ): string {
        const { misspellingDetector, aliasSuggester } = spellingHelper;

        const isMisspelled = fileSelection.wasManuallyResolved || misspellingDetector.search(rawAlias).length > 0;
        const bestMatch = aliasSuggester.search(rawAlias)?.[0];

        if (isMisspelled || (bestMatch?.score ?? 1) < 0.25) {
            return bestMatch?.item || rawAlias;
        }

        return rawAlias;
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
}
