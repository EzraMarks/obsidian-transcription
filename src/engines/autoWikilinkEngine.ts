import { requestUrl, TFile, Vault, App } from "obsidian";
import Fuse from "fuse.js";
import { TranscriptionSettings } from "src/settings";
import { StatusBar } from "../status";
import { BacklinkEngine, BacklinkEntry, BacklinksArrayDict } from "./backlinkEngine";
import { UtilsEngine } from "./utilsEngine";
import { extractSentence, findNearestHeading } from "../utils";

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

/** Metadata for a single Obsidian file */
export interface FileMetadata {
    file: TFile;
    aliases: string[];
    misspellings: string[];
}

/** A candidate match between an ExtractedEntity and a file */
export interface FileCandidate {
    /** The file’s metadata */
    file: FileMetadata;
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
    selectedFile?: FileCandidate;
    shouldCreateFile?: boolean;
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
        const entitiesJson = await this.callOpenAI(this.extractReferencesPrompt, input, { type: "json_object" });
        let extractedEntities: ExtractedEntity[];
        try {
            const aiResponse: AiExtractEntitiesResponse = JSON.parse(entitiesJson);
            extractedEntities = Object.entries(aiResponse).map(([key, value]) => {
                return { entity: key, occurrences: value.occurrences };
            });

            console.log("Extracted entities", extractedEntities);
        } catch (err) {
            const errorMessage = `
                AutoWikilink: Failed to parse extracted entities.
                Input: ${input.slice(0, 500)}${input.length > 500 ? "..." : ""}
                Response: ${entitiesJson}
                Error: ${err instanceof Error ? err.message : String(err)}
            `;
            throw new Error(errorMessage);
        }

        // Step 2: find fuzzy-match candidates
        const fileMetadatas: FileMetadata[] = files.map((file) => {
            return {
                file: file,
                aliases: this.app.metadataCache.getFileCache(file)?.frontmatter?.["aliases"] ?? [],
                misspellings: this.app.metadataCache.getFileCache(file)?.frontmatter?.["misspellings"] ?? [],
            };
        });

        const startTime = Date.now();

        const extractedEntitiesWithFileCandidates: ExtractedEntityWithFileCandidates[] = await Promise.all(
            extractedEntities.map(async (entity) => {
                const candidates = await this.getFileCandidates(entity, fileMetadatas);
                return { entity, candidates };
            }),
        );

        const endTime = Date.now();
        console.log(`Time taken: ${(endTime - startTime) / 1000} seconds`);

        console.log("File candidates", extractedEntitiesWithFileCandidates);

        // Step 4: AI selects best candidate
        const selections: EntityFileSelection[] = [];
        for (const item of extractedEntitiesWithFileCandidates.filter((item) => item.candidates.length > 0)) {
            const choice = await this.selectBestCandidate(item);
            selections.push({ entity: item, selectedFile: choice });
        }

        console.log("Selections", selections);
        console.log(
            "Selections (but readable)",
            JSON.stringify(
                selections.map((it) => ({
                    entity: it.entity.entity.entity,
                    fileChoice: it.selectedFile?.file.file.path,
                })),
                null,
                2,
            ),
        );

        // throw new Error("Done!");

        // Step 5: human resolve unresolved
        // const unresolved = selections.filter((s) => !s.selectedFile);
        // if (unresolved.length > 0) {
        //     const humanMap = await this.promptHumanForUnresolved(unresolved);
        //     this.applyHumanSelections(selections, humanMap);
        // }

        // Step 6: replace text with links
        const output = this.applyLinksToText(input, selections);
        return output;
    }

    /** Calls OpenAI chat completions with given prompt and text */
    private async callOpenAI(
        systemPrompt: string,
        userPrompt: string,
        responseFormat?: object,
        model?: string,
    ): Promise<string> {
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ];
        const payload = {
            model: model ?? this.defaultOpenAiModel,
            // temperature: 1,
            messages,
            response_format: responseFormat,
        };
        const response = await requestUrl({
            url: "https://api.openai.com/v1/chat/completions",
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.settings.openaiKey}`,
                "Content-Type": "application/json",
            },
            contentType: "application/json",
            body: JSON.stringify(payload),
        });

        return response.json.choices[0].message.content.trim();
    }

    // TODO: I should be caching, for every file that is to become a file candidate, the full FileCandidate result!
    // Really I should have a FileCandidate object and an EnrichedFileCandidate object, and that way I can...
    // - quickly gather all the ExtractedEntityWithFileCandidates
    // - from that object, derive a deduplicated list of all file candidates
    // - then make a map from FileCandidate to EnrichedFileCandidate,
    // - then, using the hashmap, make the ExtractedEntityWithEnrichedFileCandidates

    /** Returns fuzzy-matched file candidates for an entity */
    private async getFileCandidates(entity: ExtractedEntity, files: FileMetadata[]): Promise<FileCandidate[]> {
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
                file,
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
    private async selectBestCandidate(item: ExtractedEntityWithFileCandidates): Promise<FileCandidate | undefined> {
        const candidates = item.candidates.map((it) => {
            return {
                filePath: it.file.file.path,
                aliases: it.file.aliases,
                misspellings: it.file.misspellings,
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

        const raw = await this.callOpenAI(systemPrompt, userPrompt, undefined, "gpt-4o-mini");

        // Parse out the first line, strip quotes/spaces
        const firstLine = raw.split(/\r?\n/)[0] || "";
        const filePath = firstLine.trim().replace(/^["']|["']$/g, "");

        if (!filePath || filePath === "undefined") {
            return undefined;
        }

        return item.candidates.find((c) => c.file.file.path === filePath);
    }

    /** Prompts the user to resolve unresolved selections */
    private async promptHumanForUnresolved(unresolved: EntityFileSelection[]): Promise<Record<string, string>> {
        const map: Record<string, string> = {};
        // for (const u of unresolved) {
        //     const opts = u.entity.candidates.map((c) => c.file.file.basename).join(", ");
        //     const prompt = `Entity "${u.entity.entity.entity}" - choose from [${opts}], or type "none" or "new":`;
        //     const choice = await new PromptModal(this.app, prompt).open();
        //     map[u.entity.entity.entity] = choice;
        // }
        return map;
    }

    /** Applies human choices to selections */
    private applyHumanSelections(selections: EntityFileSelection[], human: Record<string, string>) {
        for (const s of selections) {
            if (!s.selectedFile) {
                const key = s.entity.entity.entity;
                const choice = human[key];
                if (choice === "none") continue;
                if (choice === "new") {
                    s.shouldCreateFile = true;
                } else {
                    s.selectedFile = s.entity.candidates.find((c) => c.file.file.basename === choice);
                }
            }
        }
    }

    /** Replaces <entity> tags with Obsidian links based on selections */
    private applyLinksToText(text: string, selections: EntityFileSelection[]): string {
        const original = text;

        // escape helper for building any regex safely
        const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // 1) build a map: plainSentence → { index, [ {variant,link}, … ] }
        type LinkInfo = { variant: string; link: string };
        const sentenceMap = new Map<string, { start: number; links: LinkInfo[] }>();

        for (const sel of selections) {
            if (!sel.selectedFile) continue;
            const basename = sel.selectedFile.file.file.basename;

            for (const occ of sel.entity.entity.occurrences) {
                // pull out the tagged sentence and the bare variant
                const tagged = occ.sentence;
                const variant = (tagged.match(/<entity>(.*?)<\/entity>/) || [])[1] || "";

                // build your [[file|label]] link
                let link = `[[${basename}|${variant}]]`;
                if (variant !== basename && variant.length - basename.length > 3) {
                    link = `[[${basename}|${basename} (${variant})]]`;
                }

                // strip tags so we get the exact sentence as it appears in `text`
                const plain = tagged.replace(/<entity>(.*?)<\/entity>/g, "$1");

                // find its first index in the original
                const start = original.indexOf(plain);
                if (start === -1) continue;

                // collect it
                if (!sentenceMap.has(plain)) {
                    sentenceMap.set(plain, { start, links: [] });
                }
                sentenceMap.get(plain)!.links.push({ variant, link });
            }
        }

        // 2) turn each entry into one Edit object
        type Edit = { start: number; end: number; replacement: string };
        const edits: Edit[] = [];

        for (const [plain, { start, links }] of sentenceMap) {
            let replaced = plain;

            // for each variant→link, do a single replace (so we don't stomp earlier ones)
            for (const { variant, link } of links) {
                const wordRe = new RegExp(`\\b${escapeRe(variant)}\\b`);
                replaced = replaced.replace(wordRe, link);
            }

            edits.push({ start, end: start + plain.length, replacement: replaced });
        }

        // 3) stitch back together from the ORIGINAL, in ascending order
        edits.sort((a, b) => a.start - b.start);
        let result = "";
        let cursor = 0;

        for (const { start, end, replacement } of edits) {
            result += original.slice(cursor, start) + replacement;
            cursor = end;
        }
        result += original.slice(cursor);

        return result;
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

    readonly defaultOpenAiModel = "gpt-4o";
}
