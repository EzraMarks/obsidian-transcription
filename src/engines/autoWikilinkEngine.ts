import { TFile, Vault, App, ItemView } from "obsidian";
import { TranscriptionSettings } from "src/settings";
import { StatusBar } from "../status";
import levenshtein from "js-levenshtein";
import { z } from "zod";

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

/** How confident the AI is in its file selection for an entity. */
export enum SelectionConfidence {
    /** The AI picked from multiple surviving candidates — a judgment call that may be wrong. */
    Uncertain = "uncertain",
    /** No matching file was found — the entity may be new or too ambiguous to resolve. */
    Unmatched = "unmatched",
    /** A single candidate survived all filtering — the AI is reasonably confident in this match. */
    Likely = "likely",
    /** The AI is highly confident — strong recent context and clear alignment with the candidate. */
    Certain = "certain",
}

/** The extracted entity being matched and the chosen file */
export interface EntityFileSelection {
    entityWithFileCandidates: ExtractedEntityWithFileCandidates;
    selectedFile?: EnrichedFile;
    newFile?: NewFile;
    wasManuallyResolved?: boolean;
    confidence: SelectionConfidence;
}

export class UserCancelledError extends Error {
    constructor() {
        super("User cancelled");
        this.name = "UserCancelledError";
    }
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
                const { selectedFile, confidence } = entityWithFileCandidates.candidates.length
                    ? await this.selectBestCandidate(entityWithFileCandidates)
                    : { selectedFile: undefined, confidence: SelectionConfidence.Unmatched };

                // TODO: Make it so that entityWithFileCandidates has its candidates sorted by most to least likely.

                return { entityWithFileCandidates, selectedFile, confidence };
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
        const finalSelections = await new Promise<EntityFileSelection[] | null>((resolve) => {
            new ResolveEntityModal(this.app, selections, enrichedFiles, this.utilsEngine, resolve).open();
        });

        if (finalSelections === null) {
            throw new UserCancelledError();
        }

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

        // Persist any new transcription spellings as misspellings on the target files
        await this.updateMisspellingsFromSelections(finalSelections);

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

            Return the entire markdown input, with no content removed and with these <entity> tags added.
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
    private async getSampleEntityOccurrences(
        enrichedFile: EnrichedFile,
        backlinks: BacklinksArrayDict,
    ): Promise<EntityOccurrence[]> {
        const backlinkEntries = this.backlinkEngine.getRandomRecentBacklinkEntries(backlinks, 3); // TODO: Add sample size to settings

        const namesToRedact = this.getMatchingNamesForFile(enrichedFile);

        const entityOccurrences: (EntityOccurrence | undefined)[] = await Promise.all(
            backlinkEntries.map((it) => {
                // Sorted by length descending because redactVaultTextForLlm expects this input order
                const sortedNamesToRedact = (
                    it.reference.displayText ? [...namesToRedact, it.reference.displayText] : [...namesToRedact]
                ).sort((a, b) => b.length - a.length);
                return this.getEntityOccurrence(it, sortedNamesToRedact);
            }),
        );
        return entityOccurrences.filter((it): it is EntityOccurrence => it != undefined);
    }

    private async getEntityOccurrence(
        backlinkEntry: BacklinkEntry,
        sortedNamesToRedact: string[],
    ): Promise<EntityOccurrence | undefined> {
        const { sourcePath, reference } = backlinkEntry;
        const file = this.utilsEngine.getFileOrThrow(sourcePath);
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split("\n");

        // only handle in-body links with position data
        if ("position" in reference && reference.position) {
            const { line: lineNum, col } = reference.position.start;
            const lineText = lines[lineNum] || "";

            const header = findNearestHeading(lines, lineNum);
            const redactedHeader = header && this.redactVaultTextForLlm(header, sortedNamesToRedact);
            const extractedSentence = extractSentence(lineText, col).trim();
            const redactedSentence = this.redactVaultTextForLlm(extractedSentence, sortedNamesToRedact);
            const displayName = backlinkEntry.reference.displayText ?? backlinkEntry.reference.link;
            const displayNamePhoneticEncoding = getPhoneticEncoding(displayName);

            return {
                header: redactedHeader,
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
    private async selectBestCandidate(
        item: ExtractedEntityWithFileCandidates,
    ): Promise<{ selectedFile: EnrichedFile | undefined; confidence: SelectionConfidence }> {
        if (item.candidates.length === 0) {
            return { selectedFile: undefined, confidence: SelectionConfidence.Unmatched };
        }

        // If the entity is only referenced by first name, check if it's newly introduced.
        // If it seems like the entity is newly introduced, assume it's unresolvable, otherwise it may get
        // spurrious matches with other entities that have the same first name.
        if (!this.isEntityReferencedByFullName(item.entity)) {
            const isNewlyIntroduced = await this.isEntityNewlyIntroduced(item.entity);
            if (isNewlyIntroduced) {
                console.log(`${item.entity.canonicalName} is newly introduced, skipping`);
                return { selectedFile: undefined, confidence: SelectionConfidence.Unmatched };
            }
        }

        // If there's only one candidate, check if it's a perfect phonetic match
        if (item.candidates.length === 1) {
            const candidate = item.candidates[0];
            const isPhoneticMatchValid = await this.isPhoneticMatchValid(candidate.matchedPhoneticEncoding);
            if (isPhoneticMatchValid) {
                return { selectedFile: candidate.enrichedFile, confidence: SelectionConfidence.Likely };
            }
        }

        console.log(`Pre-narrowed candidates for ${item.entity.canonicalName}:`, item.candidates);

        const narrowedCandidates = await this.narrowDownCandidatesByName(item.entity, item.candidates);

        if (narrowedCandidates.length === 0) {
            return { selectedFile: undefined, confidence: SelectionConfidence.Unmatched };
        }

        if (narrowedCandidates.length === 1) {
            return { selectedFile: narrowedCandidates[0].enrichedFile, confidence: SelectionConfidence.Likely };
        }

        console.log(`Narrowed candidates for ${item.entity.canonicalName}:`, narrowedCandidates);

        const { candidate: selectedCandidate, confidence } = await this.selectFromFinalCandidates(item.entity, narrowedCandidates);
        console.log("Select best candidate AI response", selectedCandidate);

        return {
            selectedFile: selectedCandidate?.enrichedFile,
            confidence: selectedCandidate ? confidence : SelectionConfidence.Unmatched,
        };
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
            You are reading journal entries and determining whether a person is being encountered for the FIRST TIME in the author's life.

            Return true ONLY if the text explicitly introduces them as new — e.g. "met X for the first time", "was introduced to X", "X just joined our team", "just started talking to X".
            Return false for all other cases, including neutral or ambiguous references.

            Default to false when in doubt.
        `.trim();

        const userPrompt = `
            Person: ${entity.canonicalName}

            Context sentences:
            ${entity.occurrences.map((occ) => occ.sentence).join("\n\n")}
        `.trim();

        console.log(`Is newly introduced AI user prompt for ${entity.canonicalName}:`, userPrompt);

        const result = await this.utilsEngine.callOpenAIStructured({
            systemPrompt,
            userPrompt,
            model: "gpt-4.1-nano",
            schemaName: "entity_discovery",
            schema: z.object({ wasJustDiscovered: z.boolean() }),
        });
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

        const result = await this.utilsEngine.callOpenAIStructured({
            systemPrompt,
            userPrompt,
            model: "gpt-4.1-nano",
            schemaName: "name_match",
            schema: z.object({ isSameName: z.boolean() }),
        });
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

            Remember, even the most strange alternative spellings and misspellings are valid matches.
        `.trim();

        let filePaths: string[] = [];
        try {
            const result = await this.utilsEngine.callOpenAIStructured({
                userPrompt: prompt,
                model: "gpt-4.1-nano",
                schemaName: "candidate_filter",
                schema: z.object({ matchingFilePaths: z.array(z.string()) }),
            });
            filePaths = result.matchingFilePaths;
        } catch (e) {
            console.error("Failed to parse AI response in narrowDownCandidatesByName:", e);
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
    ): Promise<{ candidate: FileCandidate | undefined; confidence: SelectionConfidence }> {
        const enrichedCandidates = await Promise.all(
            candidates.map(async (fileCandidate, idx) => {
                const backlinks = this.backlinkEngine.getBacklinksForFile(fileCandidate.enrichedFile.file);
                const backlinkCount = this.backlinkEngine.calculateBacklinkCount(backlinks);
                const daysSinceLastBacklinkEdit = this.backlinkEngine.calculateDaysSinceLastBacklinkEdit(backlinks);

                const sampleOccurrences = await this.getSampleEntityOccurrences(fileCandidate.enrichedFile, backlinks);
                const bodyPreview = await this.getBodyPreview(fileCandidate.enrichedFile.file);

                const candidateId = `candidate_${idx + 1}`;

                return {
                    ...fileCandidate,
                    backlinkCount,
                    daysSinceLastBacklinkEdit,
                    sampleOccurrences,
                    bodyPreview,
                    candidateId,
                };
            }),
        );

        // Build a map from candidateId to enrichedCandidate for easy lookup. We do this rather than exposing file paths to the AI,
        // because otherwise the AI may inadvertently try to match files based on name spelling rather than context, which is not desired.
        const candidateIdToCandidate = new Map<string, any>();
        for (const candidate of enrichedCandidates) {
            candidateIdToCandidate.set(candidate.candidateId, candidate);
        }

        const systemPrompt = `
            You help match mentions of entities in text to their corresponding profile.
            Given:
             - An entity (referred to as <entity/>) and the context in which they appear in the current text
             - A list of candidate profiles, each with their content and previous mentions
            Your task is to determine if this entity matches any existing profile, or if it is something new.

            Use these metrics to guide your decision:
            - days since last backlink edit — THIS IS THE MOST IMPORTANT SIGNAL. Strongly prefer candidates mentioned very recently (low values). A candidate mentioned 3 days ago is almost certainly more relevant than one mentioned 2 years ago.
            - backlink count — prefer candidates mentioned more often overall
            - sample occurrences — prefer candidates whose prior mention contexts resemble how <entity/> is used here
            - body preview — use to understand what the candidate's file is actually about

            Also return a confidence level for your selection:
            - "certain" — you are highly confident: strong recent context, clear name and context alignment, little ambiguity
            - "likely" — reasonable evidence supports the match, but it is not definitive
            - "uncertain" — best guess from available candidates; could plausibly be wrong

            - If you cannot confidently select any candidate, set selectedCandidateId to "undefined" and confidence to "uncertain".
            - Otherwise, return the identifier of the best matching candidate and your confidence.
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
                ...enrichedCandidates.map((candidate) => {
                    const occurrences = candidate.sampleOccurrences
                        .map(
                            (occ, occIdx) =>
                                `      - Occurrence ${occIdx + 1}:\n` +
                                (occ.header ? `          Header: ${occ.header}\n` : "") +
                                `          Sentence: ${occ.sentence}`,
                        )
                        .join("\n");
                    return (
                        `  - Candidate ID: ${candidate.candidateId}\n` +
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

        let selectedCandidateId: string | undefined;
        let aiConfidence: "certain" | "likely" | "uncertain" = "uncertain";
        try {
            const result = await this.utilsEngine.callOpenAIStructured({
                systemPrompt,
                userPrompt,
                model: "gpt-4.1-mini",
                schemaName: "candidate_selection",
                schema: z.object({
                    selectedCandidateId: z.string(),
                    confidence: z.enum(["certain", "likely", "uncertain"]),
                }),
            });
            selectedCandidateId = result.selectedCandidateId;
            aiConfidence = result.confidence;
        } catch (e) {
            console.error("Failed to parse AI response in selectFromFinalCandidates:", e);
            return { candidate: undefined, confidence: SelectionConfidence.Unmatched };
        }

        if (!selectedCandidateId || selectedCandidateId === "undefined") {
            return { candidate: undefined, confidence: SelectionConfidence.Unmatched };
        }

        const selectedCandidate = candidateIdToCandidate.get(selectedCandidateId);
        const confidence =
            aiConfidence === "certain" ? SelectionConfidence.Certain
            : aiConfidence === "likely" ? SelectionConfidence.Likely
            : SelectionConfidence.Uncertain;
        return { candidate: selectedCandidate, confidence };
    }

    /**
     * For each selection with a chosen file, adds any transcribed display names that aren't
     * already known (basename, alias, or misspelling) to the file's misspellings frontmatter.
     * This lets the phonetic matcher find them directly on future runs.
     */
    private async updateMisspellingsFromSelections(selections: EntityFileSelection[]): Promise<void> {
        for (const sel of selections) {
            if (!sel.selectedFile) continue;

            const file = sel.selectedFile.file;
            const knownNames = this.getMatchingNamesForFile(sel.selectedFile).map((n) => n.toLowerCase());
            const basename = file.basename.toLowerCase();

            const newMisspellings = [
                ...new Set(sel.entityWithFileCandidates.entity.occurrences.map((occ) => occ.displayName)),
            ].filter((name) => {
                const lower = name.toLowerCase();
                return lower !== basename && !knownNames.includes(lower);
            });

            if (newMisspellings.length === 0) continue;

            await this.app.fileManager.processFrontMatter(file, (fm) => {
                const existing: string[] = Array.isArray(fm.misspellings) ? fm.misspellings : [];
                const existingLower = existing.map((s: string) => s.toLowerCase());
                const toAdd = newMisspellings.filter((n) => !existingLower.includes(n.toLowerCase()));
                if (toAdd.length > 0) {
                    fm.misspellings = [...existing, ...toAdd];
                }
            });
        }
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
     * - Replacing all occurrences of any name in `namesToRedact` (e.g. "Bob Smith") with a neutral <entity/> tag.
     * - Removing all other Obsidian-style wikilinks by replacing them with their visible display name or target text.
     *
     * @param text - The full sentence text from the vault.
     * @param sortedNamesToRedact - An array of strings to replace with <entity/> (already sorted by length descending).
     * @returns A sanitized version of the text suitable for LLM input.
     */
    private redactVaultTextForLlm(text: string, sortedNamesToRedact: string[]): string {
        let redacted = text;
        for (const name of sortedNamesToRedact) {
            const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const nameRegex = new RegExp(escapedName, "g");
            redacted = redacted.replace(nameRegex, "<entity/>");
        }

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
