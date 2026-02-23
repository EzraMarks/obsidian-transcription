import { TFile, Vault, App } from "obsidian";
import { TranscriptionSettings } from "src/settings";
import { StatusBar } from "../status";
import levenshtein from "js-levenshtein";
import { z } from "zod";

import { BacklinkEngine, BacklinkEntry, BacklinksArrayDict } from "./backlinkEngine";
import { EnrichedFile, UtilsEngine } from "./utilsEngine";
import { extractSentence, findNearestHeading, getPhoneticEncoding, PhoneticEncoding, PhoneticMatch } from "../utils";
import { ResolveEntityModal } from "src/resolveEntityModal";
import { SelectionConfidence } from "./selectionConfidence";

import { MatchStrategy } from "src/pipelineDefinition";

/** An entity type with its associated candidate files */
export interface EntityTypeConfig {
    type: string; // e.g. "person"
    description?: string; // optional clarification of what counts as this type
    matchStrategy: MatchStrategy; // "phonetic" for names, "semantic" for descriptive titles
    files: TFile[]; // e.g. all person files in the vault
}

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
    type: string;
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
    /** Present for phonetic candidates; absent for semantic candidates */
    matchedPhoneticEncoding?: PhoneticMatch;
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

    /** Max candidates per LLM name-narrowing batch for semantic types. */
    private static readonly SEMANTIC_BATCH_SIZE = 300;

    /** Max number of LLM narrowing batches. Pools larger than BATCH_SIZE * MAX_BATCHES are trimmed by recency. */
    private static readonly SEMANTIC_MAX_BATCHES = 2;

    /** Main entry point: applies auto-wikilinks to the given text */
    async applyAutoWikilink(input: string, entityTypes: EntityTypeConfig[]): Promise<string> {
        // Tag all entity types in one LLM call
        const taggedText = await this.generateTaggedText(input, entityTypes);

        console.log("Tagged text", taggedText);

        // Extract entities from the tagged text (each entity now carries its type)
        const extractedEntities = this.parseTaggedEntitiesFromText(taggedText);

        // Build enriched file pools per type
        const enrichedFilesByType = new Map<string, EnrichedFile[]>();
        for (const et of entityTypes) {
            enrichedFilesByType.set(et.type, et.files.map((f) => this.utilsEngine.enrichFile(f)));
        }

        // All enriched files combined (for the modal's file picker)
        const allEnrichedFiles = [...new Map(
            [...enrichedFilesByType.values()].flat().map((f) => [f.file.path, f])
        ).values()];

        // Build file-path → entity types map so the modal can show type badges
        const fileTypeTags = new Map<string, string[]>();
        for (const [type, files] of enrichedFilesByType) {
            for (const f of files) {
                const existing = fileTypeTags.get(f.file.path) ?? [];
                existing.push(type);
                fileTypeTags.set(f.file.path, existing);
            }
        }

        // Build a lookup from type name to its config (for matchStrategy access)
        const typeConfigByName = new Map(entityTypes.map((et) => [et.type, et]));

        // Build candidates per entity using the appropriate strategy:
        //
        // PHONETIC: Phonetic pre-filter → final selection LLM
        // SEMANTIC: Load all → batched LLM name-narrowing (chunked if large) → final selection LLM

        const entitiesWithMeta = await Promise.all(
            extractedEntities.map(async (entity) => {
                const pool = enrichedFilesByType.get(entity.type) ?? [];
                const config = typeConfigByName.get(entity.type);
                const isSemantic = config?.matchStrategy === "semantic";

                const candidates: FileCandidate[] = isSemantic
                    ? pool.map((f) => ({ enrichedFile: f }))
                    : await this.getFileCandidates(entity, pool);

                return { entity, candidates, needsLlmNarrowing: isSemantic };
            }),
        );

        console.log("File candidates", entitiesWithMeta);

        // LLM-narrow entities that need it (batched per type since they share a candidate pool)
        const narrowedByEntity = new Map<string, FileCandidate[]>();

        const toNarrowByType = new Map<string, typeof entitiesWithMeta>();
        for (const item of entitiesWithMeta) {
            if (item.needsLlmNarrowing && item.candidates.length > 0) {
                const group = toNarrowByType.get(item.entity.type) ?? [];
                group.push(item);
                toNarrowByType.set(item.entity.type, group);
            }
        }

        for (const [type, items] of toNarrowByType) {
            const sharedCandidates = enrichedFilesByType.get(type)!.map((f) => ({ enrichedFile: f }));
            const batchResult = await this.narrowDownCandidatesBatched(
                items.map((i) => i.entity),
                sharedCandidates,
            );
            for (const [name, narrowed] of batchResult) {
                narrowedByEntity.set(`${name}|||${type}`, narrowed);
            }
        }

        // Build selections: use narrowed candidates if LLM-narrowed, otherwise use phonetic pre-filtered candidates directly
        const selections: EntityFileSelection[] = await Promise.all(
            entitiesWithMeta.map(async (item) => {
                const candidates = item.needsLlmNarrowing
                    ? narrowedByEntity.get(`${item.entity.canonicalName}|||${item.entity.type}`) ?? []
                    : item.candidates;

                const entityWithFileCandidates: ExtractedEntityWithFileCandidates = {
                    entity: item.entity,
                    candidates,
                };

                const { selectedFile, confidence } = await this.selectFromNarrowed(item.entity, candidates);

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
            new ResolveEntityModal(this.app, selections, allEnrichedFiles, fileTypeTags, this.utilsEngine, resolve).open();
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
     * Tag entities in the text with <entity id="Canonical Name" type="...">...</entity>
     */
    async generateTaggedText(input: string, entityTypes: EntityTypeConfig[]): Promise<string> {
        const typeNames = entityTypes.map((et) => et.type);
        const typeList = typeNames.map((t) => `"${t}"`).join(", ");
        const typeDescriptions = entityTypes
            .map((et) => `- "${et.type}"${et.description ? `: ${et.description}` : ""}`)
            .join("\n            ");

        const systemPrompt = `
            You are an entity-tagging assistant with strong coreference resolution.
            Your task is to insert <entity> tags around every mention of the following entity types in markdown text.

            Entity types:
            ${typeDescriptions}

            Instructions:
            1. Identify every reference to any of these entity types.
            2. Wrap each mention with <entity> tags, adding:
               - \`id\`: the entity's most complete/canonical name as mentioned in the text
               - \`type\`: one of ${typeList}
            - Example (types "person" and "movie"): I watched <entity id="Inception" type="movie">Inception</entity> with <entity id="F. Scott Fitzgerald" type="person">Scott</entity>.
            3. Use coreference to group different surface forms of the same entity under one canonical id.
            4. If the same surface form refers to different entities in different parts of the text, treat them as separate entities.
            5. Do not tag pronouns (he/she/they/it) or generic references.
            6. Preserve the original text exactly — only insert <entity> tags, remove nothing.

            Return the entire markdown input with <entity> tags added and nothing else changed.
        `.trim();

        const userPrompt = `
            Tag every mention of the following entity types: ${typeList}.
            Do not tag pronouns or vague references.

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
        const entityRegex = /<entity id="(.*?)" type="(.*?)">(.*?)<\/entity>/g;
        const lines = taggedText.split(/\r?\n/);

        // Key: "canonicalName|||type" to keep same-name entities of different types separate
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
                const [fullMatch, canonicalName, entityType, rawText] = match;
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

                const key = `${canonicalName}|||${entityType}`;
                if (!entities.has(key)) {
                    entities.set(key, {
                        canonicalName,
                        type: entityType,
                        occurrences: [],
                    });
                }

                entities.get(key)!.occurrences.push(occurrence);
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


    /**
     * Batched LLM name-narrowing: given multiple entities sharing a candidate pool,
     * narrows each entity's candidates via LLM. If the pool exceeds
     * SEMANTIC_BATCH_SIZE * SEMANTIC_MAX_BATCHES, it is trimmed to the most recently
     * modified files. Remaining candidates are chunked into batches.
     */
    private async narrowDownCandidatesBatched(
        entities: ExtractedEntity[],
        candidates: FileCandidate[],
    ): Promise<Map<string, FileCandidate[]>> {
        if (entities.length === 0 || candidates.length === 0) {
            return new Map(entities.map((e) => [e.canonicalName, []]));
        }

        const maxCandidates = AutoWikilinkEngine.SEMANTIC_BATCH_SIZE * AutoWikilinkEngine.SEMANTIC_MAX_BATCHES;

        // Trim to most recently modified files if pool is too large
        if (candidates.length > maxCandidates) {
            console.log(`Semantic pool has ${candidates.length} candidates — trimming to ${maxCandidates} most recent`);
            candidates = [...candidates]
                .sort((a, b) =>
                    this.getLastModifiedDate(b.enrichedFile.file).localeCompare(this.getLastModifiedDate(a.enrichedFile.file)),
                )
                .slice(0, maxCandidates);
        }

        // If the candidate pool fits in one batch, send it directly
        if (candidates.length <= AutoWikilinkEngine.SEMANTIC_BATCH_SIZE) {
            return this.narrowDownCandidatesSingleBatch(entities, candidates);
        }

        // Chunk candidates into batches and union the results across batches
        const chunks: FileCandidate[][] = [];
        for (let i = 0; i < candidates.length; i += AutoWikilinkEngine.SEMANTIC_BATCH_SIZE) {
            chunks.push(candidates.slice(i, i + AutoWikilinkEngine.SEMANTIC_BATCH_SIZE));
        }

        console.log(`Narrowing ${candidates.length} candidates in ${chunks.length} batches for ${entities.length} entities`);

        const batchResults = await Promise.all(
            chunks.map((chunk) => this.narrowDownCandidatesSingleBatch(entities, chunk)),
        );

        // Union: for each entity, combine matches from all batches (deduplicated by file path)
        const resultMap = new Map<string, FileCandidate[]>();
        for (const entity of entities) {
            const seen = new Set<string>();
            const combined: FileCandidate[] = [];
            for (const batchResult of batchResults) {
                const matches = batchResult.get(entity.canonicalName) ?? [];
                for (const match of matches) {
                    if (!seen.has(match.enrichedFile.file.path)) {
                        seen.add(match.enrichedFile.file.path);
                        combined.push(match);
                    }
                }
            }
            resultMap.set(entity.canonicalName, combined);
        }
        return resultMap;
    }

    /**
     * Single-batch LLM name-narrowing. Sends all entities and candidates in one LLM call.
     */
    private async narrowDownCandidatesSingleBatch(
        entities: ExtractedEntity[],
        candidates: FileCandidate[],
    ): Promise<Map<string, FileCandidate[]>> {
        if (entities.length === 0 || candidates.length === 0) {
            return new Map(entities.map((e) => [e.canonicalName, []]));
        }

        const entityInfos = entities.map((e) => ({
            canonicalName: e.canonicalName,
            displayNames: [...new Set(e.occurrences.map((o) => o.displayName))],
        }));

        const candidateInfos = candidates.map((c) => ({
            displayNames: this.getMatchingNamesForFile(c.enrichedFile),
            filePath: c.enrichedFile.file.path,
        }));

        const entityType = entities[0]?.type ?? "unknown";

        const prompt = `
            You are an expert at matching entities by name.
            Given a list of target entities and a shared list of candidate files, for each entity return
            the file paths that are plausible matches.

            Entity type: ${entityType}

            The targets come from transcribed speech.
            For **proper nouns** (people, places, bands, etc.), names may be phonetically garbled — match alternate spellings, misspellings, and phonetic variants (e.g. "Shawn" ↔ "Sean").
            For **descriptive names** (projects, topics, events, etc.), the speaker may paraphrase or use a casual description instead of the exact title — match by meaning and overlapping concepts (e.g. "Bedroom Shelf Project" ↔ "Building Shelves for Sleep Room").

            Rules:
            - If an entity has a full name, only include candidates whose name is a plausible variant — whether by spelling, phonetics, or meaning depending on entity type.
            - If an entity is only referenced by a short or partial name, include all candidates that could match.
            - Do not include candidates whose names are clearly different in both sound and meaning.

            Entities:
            ${entityInfos.map((e) => `  - canonicalName: ${JSON.stringify(e.canonicalName)}, displayNames: ${JSON.stringify(e.displayNames)}`).join("\n")}

            Candidates:
            ${candidateInfos.map((c) => `  - [${c.displayNames.join(", ")}] (${c.filePath})`).join("\n")}
        `.trim();

        let results: { canonicalName: string; matchingFilePaths: string[] }[] = [];
        try {
            const result = await this.utilsEngine.callOpenAIStructured({
                userPrompt: prompt,
                model: "gpt-4.1-nano",
                schemaName: "candidate_filter_batched",
                schema: z.object({
                    results: z.array(
                        z.object({
                            canonicalName: z.string(),
                            matchingFilePaths: z.array(z.string()),
                        }),
                    ),
                }),
            });
            results = result.results;
        } catch (e) {
            console.error("Failed to parse AI response in narrowDownCandidatesSingleBatch:", e);
            // Fall back: each entity gets all candidates
            return new Map(entities.map((e) => [e.canonicalName, candidates]));
        }

        const resultMap = new Map<string, FileCandidate[]>();
        for (const entity of entities) {
            const match = results.find((r) => r.canonicalName === entity.canonicalName);
            const filePaths = match?.matchingFilePaths ?? [];
            resultMap.set(
                entity.canonicalName,
                candidates.filter((c) => filePaths.includes(c.enrichedFile.file.path)),
            );
        }
        return resultMap;
    }

    /** Selects the best candidate from an already-narrowed candidate list. */
    private async selectFromNarrowed(
        entity: ExtractedEntity,
        narrowed: FileCandidate[],
    ): Promise<{ selectedFile: EnrichedFile | undefined; confidence: SelectionConfidence }> {
        if (narrowed.length === 0) {
            return { selectedFile: undefined, confidence: SelectionConfidence.Unmatched };
        }
        if (narrowed.length === 1) {
            return { selectedFile: narrowed[0].enrichedFile, confidence: SelectionConfidence.Likely };
        }
        const { candidate, confidence } = await this.selectFromFinalCandidates(entity, narrowed);
        return {
            selectedFile: candidate?.enrichedFile,
            confidence: candidate ? confidence : SelectionConfidence.Unmatched,
        };
    }

    /** Returns the last-modified date for a file as a YYYY-MM-DD string.
     * Uses the configured frontmatter field first, falling back to the file's actual mtime. */
    private getLastModifiedDate(file: TFile): string {
        const field = this.settings.lastModifiedFrontmatterField;
        if (field) {
            const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[field];
            if (value) {
                const parsed = new Date(value);
                if (!isNaN(parsed.getTime())) {
                    return parsed.toISOString().split("T")[0];
                }
            }
        }
        return new Date(file.stat.mtime).toISOString().split("T")[0];
    }

    private getMatchingNamesForFile(enrichedFile: EnrichedFile): string[] {
        return [enrichedFile.file.basename, ...(enrichedFile.aliases ?? []), ...(enrichedFile.misspellings ?? [])];
    }

    /**
     * Given an entity and a list of candidate files, uses AI to select the best matching candidate file,
     * based on the context of where the candidate has been mentioned before and the metrics of the candidate files.
     */
    private static readonly MAX_FINAL_CANDIDATES = 10;

    private async selectFromFinalCandidates(
        entity: ExtractedEntity,
        candidates: FileCandidate[],
    ): Promise<{ candidate: FileCandidate | undefined; confidence: SelectionConfidence }> {
        // Pre-fetch backlinks for all candidates once — reused for both sorting and enrichment
        const backlinksByPath = new Map(
            candidates.map((c) => [
                c.enrichedFile.file.path,
                this.backlinkEngine.getBacklinksForFile(c.enrichedFile.file),
            ]),
        );

        // Hard cap to prevent context blowout; keep most recently active (file mtime or most recent backlink edit)
        if (candidates.length > AutoWikilinkEngine.MAX_FINAL_CANDIDATES) {
            const getMostRecentActivity = (candidate: FileCandidate): number => {
                const fileMtime = candidate.enrichedFile.file.stat.mtime;
                const backlinks = backlinksByPath.get(candidate.enrichedFile.file.path) ?? [];
                const mostRecentBacklink = backlinks.reduce(
                    (max, [sourcePath]) => Math.max(max, this.utilsEngine.getSourceFileTime(sourcePath)),
                    0,
                );
                return Math.max(fileMtime, mostRecentBacklink);
            };
            candidates = [...candidates]
                .sort((a, b) => getMostRecentActivity(b) - getMostRecentActivity(a))
                .slice(0, AutoWikilinkEngine.MAX_FINAL_CANDIDATES);
        }

        const enrichedCandidates = await Promise.all(
            candidates.map(async (fileCandidate, idx) => {
                const backlinks = backlinksByPath.get(fileCandidate.enrichedFile.file.path)!;
                const backlinkCount = this.backlinkEngine.calculateBacklinkCount(backlinks);
                const daysSinceLastBacklinkEdit = this.backlinkEngine.calculateDaysSinceLastBacklinkEdit(backlinks);
                const dateLastModified = this.getLastModifiedDate(fileCandidate.enrichedFile.file);

                const sampleOccurrences = await this.getSampleEntityOccurrences(fileCandidate.enrichedFile, backlinks);
                const bodyPreview = await this.getBodyPreview(fileCandidate.enrichedFile.file);

                const candidateId = `candidate_${idx + 1}`;

                return {
                    ...fileCandidate,
                    backlinkCount,
                    daysSinceLastBacklinkEdit,
                    dateLastModified,
                    sampleOccurrences,
                    bodyPreview,
                    candidateId,
                };
            }),
        );

        // Build a map from candidateId to enrichedCandidate for easy lookup
        const candidateIdToCandidate = new Map<string, any>();
        for (const candidate of enrichedCandidates) {
            candidateIdToCandidate.set(candidate.candidateId, candidate);
        }

        const systemPrompt = `
You are matching a named entity from a speech transcription to an existing profile in a personal knowledge base.

## Key Context
- The input text is transcribed speech.
- Entity type: ${entity.type}
- For **proper nouns** (people, places, bands, etc.), transcribed names may be phonetic approximations (e.g. "Rhea" → "Riya", "Shawn" → "Sean"). Candidates have been pre-filtered by phonetic similarity.
- For **descriptive names** (projects, topics, events, etc.), the speaker may paraphrase or use a casual description instead of the exact title (e.g. "Bedroom Shelf Project" → "Building Shelves for Sleep Room"). Candidates have been pre-filtered by semantic similarity.

## How to Decide

1. **Name plausibility**: Could the transcribed name plausibly refer to the candidate? For proper nouns, this means phonetic similarity. For descriptive names, this means overlapping concepts or synonymous descriptions. This is necessary but not sufficient.

2. **Disambiguate using context and activity together**:
   - **Contextual fit** is the strongest disambiguation signal. Look at who else is mentioned nearby, what topics are being discussed, and what setting is described. Compare this to each candidate's sample occurrences and body preview. If the transcription mentions "Sophia" and one candidate always appears alongside Sophia while another never does, that's decisive — pick the contextual match regardless of activity levels.
   - **Activity and recency** are the best tiebreaker when context is ambiguous or absent. A candidate referenced dozens of times in recent weeks is far more likely to appear than one mentioned once months ago. When you can't tell from context which candidate is correct, prefer the more actively referenced one.
   - In short: context *overrides* activity when it points clearly to one candidate, but activity *breaks ties* when context is thin or inconclusive.

3. **Ruling candidates out**: Actively consider reasons a candidate might be the *wrong* match — different social context, mismatched domain, or the text implying something new or unfamiliar. If the text suggests a first encounter or a context that contradicts all candidates, select "none".

## Confidence Levels
- "certain": The name matches AND context clearly identifies the candidate (e.g. surrounding people or topics match the candidate's known associations), OR only one candidate exists and it has strong activity.
- "likely": The name matches and activity is strong but context is thin, OR context provides a reasonable but not decisive signal.
- "uncertain": The match is speculative — the name is a stretch, multiple candidates have similar activity and context, or context is contradictory.

Select "none" (not a confidence level — return selectedCandidateId: "none") when:
- No candidate's name plausibly matches (by sound or meaning)
- The text implies something new or unknown
- All candidates' contexts clearly conflict with the transcription context
        `.trim();

        const userPrompt = `
## Entity to Match
Name in transcription: "${entity.canonicalName}" (this spelling comes from speech-to-text and may be badly garbled — do NOT rely on spelling similarity to match)
Type: ${entity.type}

### Occurrences in transcription:
${entity.occurrences.map((occ, idx) =>
            `${idx + 1}. ${occ.header ? `[Under heading: ${occ.header}] ` : ""}${occ.sentence}`
        ).join("\n")}

---

## Candidates

${enrichedCandidates.map((candidate) => {
            const lastActiveDays = Math.min(
                (Date.now() - new Date(candidate.dateLastModified).getTime()) / (1000 * 60 * 60 * 24),
                candidate.daysSinceLastBacklinkEdit,
            );
            const lastActiveString = lastActiveDays === Infinity
                ? "Never"
                : `${lastActiveDays.toFixed(0)} days ago`;

            const occurrences = candidate.sampleOccurrences
                .map((occ, i) =>
                    `  ${i + 1}. ${occ.header ? `[${occ.header}] ` : ""}${occ.sentence}`
                ).join("\n");

            return `### ${candidate.candidateId}
Known names: ${this.getMatchingNamesForFile(candidate.enrichedFile).join(", ")}
Mentions: ${candidate.backlinkCount} | Last active: ${lastActiveString}

Body preview:
${candidate.bodyPreview ? candidate.bodyPreview.split("\n").map((l: string) => `> ${l}`).join("\n") : "> (empty)"}

Sample occurrences:
${occurrences || "  (none)"}`;
        }).join("\n\n")}

---

Return the best matching candidate ID, or "none" if no candidate is appropriate.
        `.trim();

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
                    reasoning: z.string(),
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

        if (!selectedCandidateId || selectedCandidateId === "none") {
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
                sel.entityWithFileCandidates.entity.canonicalName,
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

    // TODO: Make it parameterizable whether we link all occurrences or only the first occurrence per line for each entity
    private applyLinksToText(taggedText: string, selections: EntityFileSelection[]): string {
        const entityRegex = /<entity id="(.*?)"[^>]*>(.*?)<\/entity>/g;

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

                // Perform spelling correction on the surface text
                const displayName = this.correctSpelling(surfaceText, displayNames);

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

    private correctSpelling(rawDisplayName: string, displayNames: string[]): string {
        // Soundex is intentionally skipped here — it's too strict for single-name phonetic variants
        // (e.g. "Cole" vs "Nicole", soundex C400 vs N240). Metaphone distance ≤ 2 is the sole gate.
        const bestMatch = this.findBestPhoneticEncodingMatch(
            getPhoneticEncoding(rawDisplayName),
            displayNames.map((str) => getPhoneticEncoding(str)),
            2,
            Number.MAX_SAFE_INTEGER,
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
