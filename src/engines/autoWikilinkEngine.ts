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
    entity: string;
    occurrences: EntityOccurrence[];
}

/** Enriched Obsidian file */
export interface EnrichedFile {
    file: TFile;
    aliases: string[];
    misspellings: string[];
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
    entity: ExtractedEntityWithFileCandidates;
    selectedFile?: EnrichedFile;
    wasManuallyResolved?: boolean;
    newFileName?: string;
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
        // Step 1: extract entities via LLM
        const extractedEntities = await this.extractEntities(input, files);

        // Step 2: find fuzzy-match candidates
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
                return { entity: item, selectedFile };
            }),
        );

        console.log("Selections", selections);
        console.log(
            "Selections (but readable)",
            JSON.stringify(
                selections.map((it) => ({
                    entity: it.entity.entity.entity,
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

        // Step 6: replace text with links
        const output = this.applyLinksToText(input, finalSelections);
        return output;
    }

    private async extractEntities(input: string, files: TFile[]): Promise<ExtractedEntity[]> {
        const entitiesJson = await this.utilsEngine.callOpenAI({
            systemPrompt: this.extractReferencesPrompt,
            userPrompt: input,
            responseFormat: { type: "json_object" },
        });

        try {
            const aiResponse: AiExtractEntitiesResponse = JSON.parse(entitiesJson);
            return Object.entries(aiResponse).map(([key, value]) => {
                return { entity: key, occurrences: value.occurrences };
            });
        } catch (err) {
            const errorMessage = `
                AutoWikilink: Failed to parse extracted entities.
                Input: ${input.slice(0, 500)}${input.length > 500 ? "..." : ""}
                Response: ${entitiesJson}
                Error: ${err instanceof Error ? err.message : String(err)}
            `;
            throw new Error(errorMessage);
        }
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
            const match = occurrence.sentence.match(/<entity>(.*?)<\/entity>/);
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

    private applyLinksToText(text: string, selections: EntityFileSelection[]): string {
        // collect every alias‐to‐link replacement
        const replacements: { start: number; length: number; link: string }[] = [];
        // track how far we've already scanned for each alias
        const lastIndexMap = new Map<string, number>();

        for (const sel of selections) {
            if (!sel.selectedFile) continue;
            const targetName = sel.selectedFile.file.basename;
            const aliases = [targetName, ...(sel.selectedFile.aliases || [])];

            const spellingHelper = this.buildSpellingHelper(sel.selectedFile.misspellings, aliases);

            for (const occ of sel.entity.entity.occurrences) {
                // pull out the raw alias
                const { alias: rawAlias } = this.extractPlainAndAlias(occ.sentence);
                // pick the best canonical form
                const alias = this.correctSpelling(sel, rawAlias, spellingHelper);
                const link = `[[${targetName}|${alias}]]`;

                // find the next occurrence of that alias, starting after the last one
                const fromIndex = lastIndexMap.get(alias) ?? 0;
                const start = text.indexOf(alias, fromIndex);
                if (start === -1) continue;

                replacements.push({ start, length: alias.length, link });
                lastIndexMap.set(alias, start + alias.length);
            }
        }

        // apply from the end so earlier indices stay valid
        replacements.sort((a, b) => b.start - a.start);

        let result = text;
        for (const { start, length, link } of replacements) {
            result = result.slice(0, start) + link + result.slice(start + length);
        }
        return result;
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

    private extractPlainAndAlias(tagged: string): { plain: string; alias: string } {
        const alias = (tagged.match(/<entity>(.*?)<\/entity>/) || [])[1] || "";
        const plain = tagged.replace(/<entity>(.*?)<\/entity>/g, "$1");
        return { plain, alias };
    }

    /** Prompt used to extract entities via LLM */
    readonly extractReferencesPrompt = `
        You are a JSON-extraction assistant with strong coreference resolution. Given a journal entry in Markdown (with headings like ## and ###):

        1. Identify every person mentioned by name (proper nouns referring to people only).
        2. Use semantic context (not just exact text) to group mentions that refer to the same individual, even if the name form varies (e.g. "John" vs. "John Smith").
        3. If the same surface form (e.g. "John") clearly refers to different people in different contexts or sections, treat them as separate entities.
        4. For each resulting person, emit an object where the keys are the canonical names of the people, and the values are:
        - **occurrences**: an array of all sentences in which any variant of that person's name appears, each with:
            - **header**: the closest preceding Markdown heading (## or ###), or \`null\` if no heading exists above that sentence.
            - **sentence**: the full sentence, with the name mention wrapped in <entity> and </entity>.
        5. Never wrap pronouns in <entity>…</entity>; only wrap explicit named mentions.

        Output strictly a JSON object matching this schema:

        {
            "CanonicalName": {
                "occurrences": [
                    {
                        "header": "HeaderName or null",
                        "sentence": "Full sentence with <entity>VariantForm</entity> highlighted."
                    }
                ]
            },
            ...
        }
    `;
}
