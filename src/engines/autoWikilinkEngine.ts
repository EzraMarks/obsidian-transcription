import { TFile, Vault, App, ItemView } from "obsidian";
import { TranscriptionSettings } from "src/settings";
import { StatusBar } from "../status";
import levenshtein from "js-levenshtein";

import { BacklinkEngine, BacklinkEntry, BacklinksArrayDict } from "./backlinkEngine";
import { EnrichedFile, UtilsEngine } from "./utilsEngine";
import { extractSentence, findNearestHeading, getPhoneticEncoding, PhoneticEncoding, PhoneticMatch } from "../utils";
import { ResolveEntityModal } from "src/resolveEntityModal";

/** One sentence in which the entity appears */
export interface EntityOccurrence {
    header: string | null | undefined;
    displayName: string;
    displayNamePhoneticEncoding: PhoneticEncoding;
    sentence: string;
}

/** A single proper-noun (grouped across variants) and all its mentions */
export interface ExtractedEntity {
    canonicalName: string;
    occurrences: EntityOccurrence[];
}

export interface NewFile {
    baseName: string;
    aliases?: string[];
    misspellings?: string[];
}

/** A candidate match between an ExtractedEntity and a file */
export interface FileCandidate {
    enrichedFile: EnrichedFile;
    matchedPhoneticEncoding: PhoneticMatch;
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
        const enrichedFiles: EnrichedFile[] = files.map((file) => this.utilsEngine.enrichFile(file));

        console.log("Files", enrichedFiles);

        const extractedEntitiesWithFileCandidates: ExtractedEntityWithFileCandidates[] = await Promise.all(
            extractedEntities.map(async (entity) => {
                const candidates = await this.getFileCandidates(entity, enrichedFiles);
                return { entity, candidates };
            }),
        );

        console.log("File candidates", extractedEntitiesWithFileCandidates);

        // AI selects best candidate
        const selections: EntityFileSelection[] = await Promise.all(
            extractedEntitiesWithFileCandidates.map(async (entityWithFileCandidates) => {
                const selectedFile = entityWithFileCandidates.candidates.length
                    ? await this.selectBestCandidate(entityWithFileCandidates)
                    : undefined;

                // TODO: Make it so that entityWithFileCandidates has its candidates sorted by most to least likely.

                return { entityWithFileCandidates: entityWithFileCandidates, selectedFile };
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
            new ResolveEntityModal(this.app, selections, enrichedFiles, this.utilsEngine, resolve).open();
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
            - Example: I recently read <entity id="The Great Gatsby">The Great Gatsby</entity> by <entity id="F. Scott Fitzgerald">F. Scott Fitzgerald</entity>.
            3. Use semantic context and coreference to group different surface forms (e.g., "Gatsby" = "The Great Gatsby").
            4. If the **same surface form** refers to **different people** in different parts of the text, treat them as different entities.
            5. Do not tag pronouns, e.g., "she"/"he"/"the person"
            6. Preserve the original text exactly, modifying it only by inserting <entity id="...">Name</entity> tags.

            Output only the modified text with <entity> tags.
        `.trim();

        const userPrompt = `
            Tag every mention of a person's name in the following text, without tagging pronouns like he/she/they.

            ${input}
        `.trim();

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
                const redactedHeader = currentHeader && this.redactTranscriptionTextForLlm(currentHeader);

                const occurrence: EntityOccurrence = {
                    header: redactedHeader,
                    displayName: rawText,
                    displayNamePhoneticEncoding: getPhoneticEncoding(rawText),
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

    /** Returns fuzzy-matched file candidates for an entity */
    private async getFileCandidates(entity: ExtractedEntity, enrichedFiles: EnrichedFile[]): Promise<FileCandidate[]> {
        // Maximum number of characters that can differ between two metaphone encodings
        const maxLevenshteinDistance = 1;

        const displayNameOccurrences = [...new Set(entity.occurrences.map((item) => item.displayName))];
        const phoneticEncodings = displayNameOccurrences.map((displayName) => getPhoneticEncoding(displayName));

        return enrichedFiles
            .map((file): FileCandidate | undefined => {
                // Find all phonetic encodings from the entity that match any encoding in the file
                const matchedEncodings = phoneticEncodings
                    .map((entityEncoding) => this.findBestPhoneticEncodingMatch(entityEncoding, file.phoneticEncodings))
                    .filter((it): it is PhoneticMatch => it != undefined);

                if (!matchedEncodings.length) {
                    return undefined;
                }

                // Pick the matched encoding with the lowest phonetic distance, breaking ties by longest displayName
                const bestMatch = matchedEncodings.reduce((best, current) => {
                    if (
                        current.phoneticDistance < best.phoneticDistance ||
                        (current.phoneticDistance === best.phoneticDistance &&
                            current.candidateEncoding.displayName.length > best.candidateEncoding.displayName.length)
                    ) {
                        return current;
                    }
                    return best;
                }, matchedEncodings[0]);

                return { enrichedFile: file, matchedPhoneticEncoding: bestMatch };
            })
            .filter((candidate): candidate is FileCandidate => candidate != undefined);
    }

    /**
     * Finds the best matching phonetic encoding from a list of candidates.
     * By default:
     *   - Only considers candidates with the same soundex encoding
     *   - Requires at least one metaphone encoding within a Levenshtein distance of maxLevenshteinDistance
     *   - Prefers the closest metaphone match, breaking ties by display name similarity
     */
    private findBestPhoneticEncodingMatch(
        targetEncoding: PhoneticEncoding,
        candidateEncodings: PhoneticEncoding[],
        maxMetaphoneDistance: number = 1,
        maxSoundexDistance: number = 0,
    ): PhoneticMatch | undefined {
        let bestMatch: PhoneticMatch | undefined;

        for (const candidate of candidateEncodings) {
            const soundexDistance = levenshtein(targetEncoding.soundexEncoding, candidate.soundexEncoding);

            if (soundexDistance > maxSoundexDistance) continue;

            // Compare all metaphone encodings between target and candidate
            for (const targetMetaphone of targetEncoding.metaphoneEncodings) {
                for (const candidateMetaphone of candidate.metaphoneEncodings) {
                    const metaphoneDistance = levenshtein(targetMetaphone, candidateMetaphone);

                    if (metaphoneDistance > maxMetaphoneDistance) continue;

                    // Also compare the display names for tie-breaking
                    const displayNameDistance = levenshtein(targetEncoding.displayName, candidate.displayName);

                    const isBetterMatch =
                        !bestMatch ||
                        metaphoneDistance < bestMatch.phoneticDistance ||
                        (metaphoneDistance === bestMatch.phoneticDistance &&
                            displayNameDistance < bestMatch.displayNameDistance);

                    if (isBetterMatch) {
                        bestMatch = {
                            candidateEncoding: candidate,
                            targetEncoding,
                            phoneticDistance: metaphoneDistance,
                            displayNameDistance,
                        };
                    }
                }
            }
        }

        return bestMatch;
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
            const displayName = backlinkEntry.reference.displayText ?? backlinkEntry.reference.link;
            const displayNamePhoneticEncoding = getPhoneticEncoding(displayName);

            return {
                header,
                displayName,
                displayNamePhoneticEncoding,
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

        const preview = body.length <= 400 ? body : body.slice(0, 400) + "...";
        return preview;
    }

    /** AI selects best candidate or undefined */
    private async selectBestCandidate(item: ExtractedEntityWithFileCandidates): Promise<EnrichedFile | undefined> {
        if (item.candidates.length === 0) {
            return undefined;
        }

        const isEntityReferencedByFullName = this.isEntityReferencedByFullName(item.entity);

        // If the entity is only referenced by first name, check if it's newly introduced.
        // If it seems like the entity is newly introduced, assume it's unresolvable, otherwise it may get
        // spurrious matches with other entities that have the same first name.
        if (!isEntityReferencedByFullName) {
            const isUnresolvable = await this.isEntityNewlyIntroduced(item.entity);
            if (isUnresolvable) {
                console.log(`${item.entity.canonicalName} is newly introduced, skipping`);
                return undefined;
            }
        }

        // If there's only one candidate, check if it's a perfect match
        if (item.candidates.length === 1) {
            const candidate = item.candidates[0];
            const isPhoneticMatchValid = await this.isPhoneticMatchValid(candidate.matchedPhoneticEncoding);
            if (isPhoneticMatchValid) {
                return candidate.enrichedFile;
            }
        }

        console.log(`Pre-narrowed candidates for ${item.entity.canonicalName}:`, item.candidates);

        const narrowedCandidates = await this.narrowDownCandidatesByName(item.entity, item.candidates);

        if (narrowedCandidates.length <= 1) {
            return narrowedCandidates[0]?.enrichedFile;
        }

        console.log(`Narrowed candidates for ${item.entity.canonicalName}:`, narrowedCandidates);

        const selectedCandidate = await this.selectFromFinalCandidates(item.entity, narrowedCandidates);
        console.log("Select best candidate AI response", selectedCandidate);

        return selectedCandidate?.enrichedFile;
    }

    /** Returns true if the entity is referenced by its full name at least once */
    private isEntityReferencedByFullName(entity: ExtractedEntity): boolean {
        return entity.occurrences.some((occ) => occ.displayName.includes(" "));
    }

    /**
     * Determines if this is the first time the author has interacted with or mentioned this entity.
     * Returns true if the entity appears to be newly discovered/mentioned for the first time, false otherwise.
     */
    private async isEntityNewlyIntroduced(entity: ExtractedEntity): Promise<boolean> {
        const systemPrompt = `
            You are an AI that helps determine if this is the first time the author has interacted with or mentioned an entity.
            Given a list of sentences where an entity appears, determine if this is the first time the author has encountered or written about this entity.

            ONLY respond that this is the first time ("wasJustDiscovered": true) if it is VERY CLEAR and UNAMBIGUOUS from the context that the entity is being introduced for the first time.
            If there is any doubt, ambiguity, or lack of strong evidence, you MUST assume that the entity has been mentioned or interacted with before ("wasJustDiscovered": false).

            This is the first time the author has interacted with the entity ONLY IF:
            1. The context explicitly introduces the entity as new (e.g. "I met X's friend Y for the first time", "I was introduced to Y", "Y just joined our team", "I just discovered Y", "I just read X for the first time").
            2. There are clear, explicit statements that this is the author's first interaction or mention of the entity.

            This is NOT the first time if:
            1. The context is ambiguous, neutral, or could be interpreted either way.
            2. The entity is referred to in a way that suggests the author is already familiar with it (e.g. being used in a context that assumes familiarity).
            3. The entity is referenced in a way that assumes the reader already knows what it is.
            4. The context suggests the author has interacted with or mentioned this entity before.

            When in doubt, ALWAYS default to "wasJustDiscovered": false.

            Respond with a JSON object in this format:
            {
                "wasJustDiscovered": boolean
            }
        `.trim();

        const userPrompt = `
            Context sentences:

            ${entity.occurrences.map((occ) => occ.sentence).join("\n\n")}
        `.trim();

        const response = await this.utilsEngine.callOpenAI({
            systemPrompt,
            userPrompt,
            model: "gpt-4.1-nano",
            responseFormat: { type: "json_object" },
        });

        console.log(`Is newly introduced AI user prompt for ${entity.canonicalName}:`, userPrompt);

        const result = JSON.parse(response) as { wasJustDiscovered: boolean };
        return result.wasJustDiscovered;
    }

    /**
     * Determines if two names are the same, just spelled differently.
     * Uses AI to analyze the names.
     */
    private async isPhoneticMatchValid(phoneticMatch: PhoneticMatch): Promise<boolean> {
        if (phoneticMatch.displayNameDistance === 0 || phoneticMatch.phoneticDistance === 0) {
            return true;
        }

        const candidateDisplayName = phoneticMatch.candidateEncoding.displayName;
        const targetDisplayName = phoneticMatch.targetEncoding.displayName;

        const systemPrompt = `
            You are an AI that determines if two names are the same name, just spelled differently.
            Given two names, respond true if they are the same name with different spellings, false otherwise.

            Respond with a JSON object in this format:
            {
                "isSameName": boolean
            }
        `.trim();

        const userPrompt = `
            Name 1: ${targetDisplayName}
            Name 2: ${candidateDisplayName}
        `.trim();

        const response = await this.utilsEngine.callOpenAI({
            systemPrompt,
            userPrompt,
            model: "gpt-4.1-nano",
            responseFormat: { type: "json_object" },
        });

        const result = JSON.parse(response) as { isSameName: boolean };
        return result.isSameName;
    }

    /**
     * Uses AI to narrow down the list of candidate files for an entity based on display name similarity and full name logic.
     *
     * The AI is provided with all display names for the entity (e.g., ["John Jacobson", "John"]) and the display names for each candidate.
     * It is instructed to return only those candidates whose names could plausibly refer to the same person as the entity.
     *
     * If the entity's full name (e.g., "John Jacobson") is present, the AI should strongly prefer exact or near-exact matches on the full name,
     * and should exclude candidates whose full names are clearly different, even if there is overlap on first names (e.g., ["John Smith", "John"]).
     * For example, if the entity is ["John Jacobson", "John"] and the candidates are
     *   [
     *     ["John Jones", "John"], // filePath john_jones.md
     *     ["John Smith", "John"], // filePath john_smith.md
     *     ["John Smieth", "John"] // filePath john_smeith.md
     *   ],
     * the AI should recognize that ["John Smith", "John"] and ["John Smieth", "John"] are not matches for ["John Jacobson", "John"]
     * and return an empty list, despite the shared first name.
     *
     * If the entity and a candidate share only a first name, but the full names are clearly different, the candidate should be excluded.
     * Only candidates whose full names are plausible alternate spellings or variants of the entity's full name should be retained.
     *
     * However, if the entity is referenced only by a first name (e.g., ["John"]), then all candidates with that first name,
     * regardless of their last names, should be included, since there is not enough information to disambiguate.
     *
     * Example 1:
     *   Target: ["John Jacobson", "John"]
     *   Candidates:
     *     [
     *       ["John Jones", "John"], // filePath john_jones.md
     *       ["John Smith", "John"], // filePath john_smith.md
     *       ["John Smieth", "John"], // filePath john_smeith.md
     *     ]
     *   Result: []
     *
     * Example 2:
     *   Target: ["Aidan Clarage", "Aidan"]
     *   Candidates:
     *     [
     *       ["Aiden Clarage", "Aiden"] (filePath aiden_clarage.md),
     *       ["Aidan Cassel-Mace", "Aidan"] (filePath aidan_cassel_mace.md)
     *     ]
     *   Result: ["aiden_clarage.md"]
     *
     * Example 3:
     *   Target: ["John"]
     *   Candidates:
     *     [
     *       ["John Jones"], // filePath john_jones.md
     *       ["John Smith"], // filePath john_smith.md
     *       ["John Smieth"], // filePath john_smeith.md
     *     ]
     *   Result: ["john_jones.md", "john_smith.md", "john_smeith.md"]
     *
     * @param entity The extracted entity with its display names.
     * @param candidates The list of FileCandidate objects to filter.
     * @returns A Promise resolving to the narrowed list of FileCandidate objects.
     */
    private async narrowDownCandidatesByName(
        entity: ExtractedEntity,
        candidates: FileCandidate[],
    ): Promise<FileCandidate[]> {
        const entityNames = entity.occurrences.map((it) => it.displayName);
        const candidateInfos = candidates.map((it) => ({
            displayNames: this.getMatchingNamesForFile(it.enrichedFile),
            filePath: it.enrichedFile.file.path,
        }));

        // Compose a prompt for the LLM
        const prompt = `
            You are an expert at matching people by name, even with alternate spellings.
            Given a target person (with one or more display names) and a list of candidate people (with their display names and file paths), return the list of file paths that are plausible matches for the target, based only on the names.

            Rules:
            - If the target has a full name, only include candidates whose full name is a plausible alternate spelling or variant of the target's full name.
            - If the target is referenced only by a first name, include all candidates with that first name.
            - Do not include candidates whose full names are clearly different, even if the first name matches.

            Target display names: ${JSON.stringify(entityNames)}

            Candidates:
            ${candidateInfos.map((it) => `  - [${it.displayNames.join(", ")}] (${it.filePath})`).join("\n")}

            Return a JSON object in this format:
            {
                "matchingFilePaths": string[]  // List of file paths that are plausible matches
            }
        `.trim();

        const rawResponse = await this.utilsEngine.callOpenAI({
            userPrompt: prompt,
            model: "gpt-4.1-nano",
            responseFormat: { type: "json_object" },
        });

        // Parse the AI response as a JSON object
        let filePaths: string[] = [];
        try {
            const result = JSON.parse(rawResponse) as { matchingFilePaths: string[] };
            filePaths = result.matchingFilePaths;
        } catch (e) {
            console.error("Failed to parse AI response in narrowDownCandidatesByName:", rawResponse, e);
            // Fallback: return all candidates
            return candidates;
        }

        // Filter the candidates to only those whose file path is in the AI's list
        const filtered = candidates.filter((c) => filePaths.includes(c.enrichedFile.file.path));
        return filtered;
    }

    private getMatchingNamesForFile(enrichedFile: EnrichedFile): string[] {
        return [enrichedFile.file.basename, ...(enrichedFile.aliases ?? []), ...(enrichedFile.misspellings ?? [])];
    }

    /**
     * Given an entity and a list of candidate files, uses AI to select the best matching candidate file,
     * based on the context of where the candidate has been mentioned before and the metrics of the candidate files.
     */
    private async selectFromFinalCandidates(
        entity: ExtractedEntity,
        candidates: FileCandidate[],
    ): Promise<FileCandidate | undefined> {
        const enrichedCandidates = await Promise.all(
            candidates.map(async (fileCandidate) => {
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

        const systemPrompt = `
            You are an AI that helps match mentions of entities in text to their corresponding profile pages.
            Given:
             - An entity (referred to as <entity/>) and the context in which they appear in the current text
             - A list of candidate profiles, each with their content and previous mentions
            Your task is to determine if this entity matches any existing profile, or if it is something new.

            Also consider the following metrics for each candidate:
            - backlink count (indicates how often this entity has been mentioned in the past, so the AI should prefer candidates with more backlinks)
            - days since last backlink edit (indicates how recently this entity has been mentioned, so the AI should prefer candidates with more recent backlinks)
            - body preview (some content of this candidate entity's file)
            - sample occurrences (indicates the specific ways in which this candidateentity is mentioned, so the AI should prefer candidates with more similar occurrences)

            Respond ONLY with a JSON string in this format:
            {
                "selectedFilePath": string | "undefined" // The file path of the best matching candidate, or "undefined" if you cannot confidently select one
            }

            - If you are not confident in any match, or if the entity is new, return "undefined".
            - Otherwise, return the file path of the best matching candidate.
        `.trim();

        const userPrompt = `
Sample context of the entity to match (shown as <entity/>):
${[
    "Entity Occurrences:",
    ...entity.occurrences.map(
        (occurrence, idx) =>
            `  - Occurrence ${idx + 1}:\n` +
            (occurrence.header ? `      Header: ${occurrence.header}\n` : "") +
            `      Sentence: ${occurrence.sentence}`,
    ),
    "",
    "Candidate Profiles:",
    ...enrichedCandidates.map((candidate, idx) => {
        const occurrences = candidate.sampleOccurrences
            .map(
                (occ, occIdx) =>
                    `      - Occurrence ${occIdx + 1}:\n` +
                    (occ.header ? `          Header: ${occ.header}\n` : "") +
                    `          Sentence: ${occ.sentence}`,
            )
            .join("\n");
        return (
            `  - Candidate ${idx + 1}:\n` +
            `      File Path: ${candidate.enrichedFile.file.path}\n` +
            `      Backlink Count: ${candidate.backlinkCount}\n` +
            `      Days Since Last Backlink Edit: ${candidate.daysSinceLastBacklinkEdit}\n` +
            `      Body Preview:\n` +
            (candidate.bodyPreview
                ? candidate.bodyPreview
                      .split("\n")
                      .map((line) => `        ${line}`)
                      .join("\n")
                : "        (No preview available)") +
            `\n      Sample Occurrences:\n` +
            (occurrences ? occurrences : "        (No sample occurrences)")
        );
    }),
].join("\n")}
        `;

        console.log(`Select from final candidates AI system prompt for ${entity.canonicalName}:`, systemPrompt);
        console.log(`Select from final candidates AI user prompt for ${entity.canonicalName}:`, userPrompt);

        const rawResponse = await this.utilsEngine.callOpenAI({
            systemPrompt,
            userPrompt,
            model: "gpt-4.1-mini",
            responseFormat: { type: "json_object" },
        });

        let selectedFilePath: string | undefined;
        try {
            const aiResponse = JSON.parse(rawResponse) as { selectedFilePath: string };
            selectedFilePath = aiResponse.selectedFilePath;
        } catch (e) {
            console.error("Failed to parse AI response in selectFromFinalCandidates:", rawResponse, e);
            return undefined;
        }

        if (!selectedFilePath || selectedFilePath === "undefined") {
            return undefined;
        }

        return enrichedCandidates.find((c) => c.enrichedFile.file.path === selectedFilePath);
    }

    // TOOD: Make is parameterizable whether we link all occurrences or only the first occurrence per line for each entity
    private applyLinksToText(taggedText: string, selections: EntityFileSelection[]): string {
        const entityRegex = /<entity id="(.*?)">(.*?)<\/entity>/g;

        const entityToSelection = new Map<string, EntityFileSelection>();
        for (const sel of selections) {
            entityToSelection.set(sel.entityWithFileCandidates.entity.canonicalName, sel);

            if (sel.newFile) {
                this.createNewFile("", sel.newFile);
            }
        }

        // Split into lines to check for headers
        const lines = taggedText.split(/\r?\n/);

        const replacedLines = lines.map((line) => {
            const isHeader = /^#+ /.test(line);

            // Track which entities have already been linked in this line
            const linkedEntities = new Set<string>();

            // Replace entities in the line, only linking the first occurrence per entity
            return line.replace(entityRegex, (_fullMatch, canonicalName, surfaceText) => {
                const sel = entityToSelection.get(canonicalName);

                const targetName = sel?.selectedFile?.file.basename || sel?.newFile?.baseName;

                if (!targetName) {
                    // No selection → just unwrap the <entity> and keep the surface text
                    return surfaceText;
                }

                const displayNames = [targetName, ...(sel.selectedFile?.aliases ?? sel?.newFile?.aliases ?? [])];
                const misspellings = sel.selectedFile?.misspellings ?? sel?.newFile?.misspellings ?? [];

                // Perform spelling correction on the surface text
                const displayName = this.correctSpelling(sel, surfaceText, displayNames, misspellings);

                if (isHeader) {
                    // In headers, just use the displayName (no wikilink)
                    return displayName;
                }

                // Not a header: handle wikilinking
                const isFirstOccurrence = !linkedEntities.has(canonicalName);

                if (isFirstOccurrence) {
                    linkedEntities.add(canonicalName);
                    // First occurrence in this line: wikilink
                    if (targetName === displayName) {
                        return `[[${targetName}]]`;
                    } else {
                        return `[[${targetName}|${displayName}]]`;
                    }
                } else {
                    // Subsequent occurrence: just use displayName
                    return displayName;
                }
            });
        });

        return replacedLines.join("\n");
    }

    private correctSpelling(
        fileSelection: EntityFileSelection,
        rawDisplayName: string,
        displayNames: string[],
        misspellings: string[],
    ): string {
        const isMisspelled = misspellings.includes(rawDisplayName) || fileSelection.wasManuallyResolved;

        const bestMatch = this.findBestPhoneticEncodingMatch(
            getPhoneticEncoding(rawDisplayName),
            displayNames.map((str) => getPhoneticEncoding(str)),
            isMisspelled ? Number.MAX_SAFE_INTEGER : 2,
            isMisspelled ? Number.MAX_SAFE_INTEGER : 0,
        );

        return bestMatch?.candidateEncoding?.displayName || rawDisplayName;
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
    private redactTranscriptionTextForLlm(text: string, targetEntitySubstring?: string): string {
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
