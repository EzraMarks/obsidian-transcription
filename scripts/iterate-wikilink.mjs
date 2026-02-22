#!/usr/bin/env node
/**
 * iterate-wikilink.mjs — Test entity tagging and resolution.
 *
 * Strips existing [[wikilinks]] from a processed journal entry, runs the entity-
 * tagging LLM, and (by default) runs the full resolution pipeline against your
 * live vault via the Obsidian Local REST API.  Compares results to the original
 * wikilinks so you can see what changed.
 *
 * Usage:
 *   node scripts/iterate-wikilink.mjs [OPTIONS] <journal.md> [...]
 *
 * Options:
 *   --entry <n>          Process only entry N (1-based). Without this, lists entries.
 *   --all                Process all entries.
 *   --tagging-only       Only run entity tagging; skip resolution.
 *   --config <path>      YAML pipeline config (default: referenceConfiguration/journalTranscription.yaml)
 *   --obsidian-key <key> Obsidian Local REST API key (or OBSIDIAN_API_KEY env var / data.json).
 *   --obsidian-url <url> Obsidian REST API base URL (default: http://127.0.0.1:27123).
 *   --strip-only         Show stripped input without calling any APIs.
 *   --help               Show this help.
 *
 * API keys:
 *   OpenAI:   OPENAI_API_KEY env var, or data.json → "openaiKey"
 *   Obsidian: OBSIDIAN_API_KEY env var, or data.json → "obsidianApiKey", or --obsidian-key
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "yaml";
import { minimatch } from "minimatch";
import { doubleMetaphone } from "double-metaphone";
import { soundex } from "soundex-code";
import levenshtein from "js-levenshtein";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "..");
const DEFAULT_YAML_CONFIG = resolve(PLUGIN_DIR, "referenceConfiguration/journalTranscription.yaml");
const DATA_JSON = resolve(PLUGIN_DIR, "data.json");
const DEFAULT_OBSIDIAN_URL = "http://127.0.0.1:27123";
const LOCAL_REST_API_DATA_JSON = resolve(PLUGIN_DIR, "../obsidian-local-rest-api/data.json");

/** Files with this many or fewer candidates skip phonetic pre-filtering. */
const LOAD_ALL_THRESHOLD = 150;

// ── ANSI colors ──────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

// ── CLI arg parsing ───────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = {
        configPath: null, entry: null, all: false, taggingOnly: false,
        obsidianKey: null, obsidianUrl: null,
        stripOnly: false, files: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--config") opts.configPath = argv[++i];
        else if (a === "--entry" || a === "-e") opts.entry = parseInt(argv[++i], 10);
        else if (a === "--all" || a === "-a") opts.all = true;
        else if (a === "--tagging-only" || a === "-t") opts.taggingOnly = true;
        else if (a === "--obsidian-key") opts.obsidianKey = argv[++i];
        else if (a === "--obsidian-url") opts.obsidianUrl = argv[++i];
        else if (a === "--strip-only" || a === "-s") opts.stripOnly = true;
        else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
        else if (!a.startsWith("-")) opts.files.push(a);
    }
    return opts;
}

function printHelp() {
    console.log(`
${BOLD}iterate-wikilink.mjs${R} — Test entity tagging and resolution

${BOLD}Usage:${R}
  node scripts/iterate-wikilink.mjs [OPTIONS] <journal.md> [...]

${BOLD}Options:${R}
  --entry <n>          Process only entry N (1-based)
  --all                Process all entries
  --tagging-only       Only run entity tagging; skip vault loading and resolution
  --config <path>      YAML pipeline config
                       (default: referenceConfiguration/journalTranscription.yaml)
  --obsidian-key <key> Obsidian Local REST API key
  --obsidian-url <url> Obsidian REST API URL (default: http://127.0.0.1:27123)
  --strip-only         Show stripped input without API calls
  --help               Show this help

${BOLD}API keys:${R}
  OpenAI:   OPENAI_API_KEY env var, or data.json → "openaiKey"
  Obsidian: OBSIDIAN_API_KEY env var, or data.json → "obsidianApiKey"
`);
}

// ── Config ────────────────────────────────────────────────────────────────────
function readWikilinkConfig(configPath) {
    const content = readFileSync(configPath, "utf8");
    const parsed = yaml.parse(content);
    const step = parsed.steps?.find((s) => s.type === "auto_wikilink");
    if (!step) throw new Error(`No auto_wikilink step found in ${configPath}`);
    return { entityTypes: step.entity_types ?? [] };
}

// ── Text processing ───────────────────────────────────────────────────────────
function stripFrontmatter(text) {
    return text.replace(/^---[\s\S]*?---\s*\n?/, "").trim();
}

function splitIntoEntries(text) {
    const lines = text.split("\n");
    const entries = [];
    let currentTitle = null, currentLines = [];
    for (const line of lines) {
        if (/^## /.test(line)) {
            if (currentLines.length > 0 || currentTitle !== null) {
                entries.push({ title: currentTitle ?? "(no heading)", content: currentLines.join("\n").trim() });
            }
            currentTitle = line.replace(/^## /, "").trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    if (currentLines.length > 0 || currentTitle !== null) {
        entries.push({ title: currentTitle ?? "(no heading)", content: currentLines.join("\n").trim() });
    }
    return entries.filter((e) => e.content.trim().length > 0);
}

/**
 * Strip ###/#### section headers and standalone embeds from an entry to get
 * the wikilink-step input (which receives the output of add_headers).
 * We keep headers because the tagging LLM uses them for context.
 */
function stripSectionStructure(text) {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs
        .filter((p) => {
            const t = p.trim();
            if (!t) return false;
            if (/^#{3,6}\s/.test(t)) return false;
            if (/^!\[\[.*\]\]\s*$/.test(t)) return false;
            return true;
        })
        .join("\n\n");
}

/** Non-note file extensions that wikilinks might point to (not entities). */
const NON_NOTE_EXT = /\.(m4a|mp3|wav|mp4|mov|jpg|jpeg|png|gif|svg|pdf|webp)$/i;

/** Parse all [[wikilinks]] from text and return unique note links (excluding audio/images). */
function parseOriginalWikilinks(text) {
    const seen = new Map(); // target → display
    const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const target = match[1].trim();
        if (NON_NOTE_EXT.test(target)) continue; // skip audio/image embeds
        const display = (match[2] ?? match[1]).trim();
        if (!seen.has(target)) seen.set(target, display);
    }
    return [...seen.entries()].map(([target, display]) => ({ target, display }));
}

/** Replace wikilinks with their display text. */
function stripWikilinks(text) {
    return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => display || target);
}

// ── Phonetic encoding (mirrors src/utils.ts) ──────────────────────────────────
function getPhoneticEncoding(name) {
    return { displayName: name, soundexEncoding: soundex(name), metaphoneEncodings: doubleMetaphone(name) };
}

/** Find best phonetic match (mirrors AutoWikilinkEngine.findBestPhoneticEncodingMatch). */
function findBestPhoneticMatch(target, candidates, maxMeta = 1, maxSoundex = 0) {
    let best;
    for (const candidate of candidates) {
        const soundexDist = levenshtein(target.soundexEncoding, candidate.soundexEncoding);
        if (soundexDist > maxSoundex) continue;
        for (const tm of target.metaphoneEncodings) {
            for (const cm of candidate.metaphoneEncodings) {
                const metaDist = levenshtein(tm, cm);
                if (metaDist > maxMeta) continue;
                const nameDist = levenshtein(target.displayName, candidate.displayName);
                if (!best || metaDist < best.phoneticDistance || (metaDist === best.phoneticDistance && nameDist < best.displayNameDistance)) {
                    best = { candidateEncoding: candidate, targetEncoding: target, phoneticDistance: metaDist, displayNameDistance: nameDist };
                }
            }
        }
    }
    return best;
}

// ── Obsidian REST API ─────────────────────────────────────────────────────────
function obsidianHeaders(apiKey) {
    return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}

/** List one folder. Returns items relative to that folder (files end in .md, subdirs end in /). */
async function listVaultFolder(folderPath, obsidianUrl, apiKey) {
    const url = `${obsidianUrl}/vault/${encodePath(folderPath)}/`;
    const res = await fetch(url, { headers: obsidianHeaders(apiKey) });
    if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`Vault list error ${res.status} for ${folderPath}`);
    }
    const json = await res.json();
    return json.files ?? [];
}

/** Recursively collect all .md file paths matching a glob, using the REST API. */
async function listFilesForGlob(pattern, obsidianUrl, apiKey) {
    const staticPrefix = getStaticPrefix(pattern);
    const isRecursive = pattern.includes("**");
    const files = [];

    async function walk(currentPath) {
        const items = await listVaultFolder(currentPath, obsidianUrl, apiKey);
        await Promise.all(items.map(async (item) => {
            if (item.endsWith("/")) {
                if (isRecursive) {
                    await walk(currentPath ? `${currentPath}/${item.slice(0, -1)}` : item.slice(0, -1));
                }
            } else if (item.endsWith(".md")) {
                const fullPath = currentPath ? `${currentPath}/${item}` : item;
                if (minimatch(fullPath, pattern)) files.push(fullPath);
            }
        }));
    }

    await walk(staticPrefix);
    return files;
}

function getStaticPrefix(pattern) {
    const idx = pattern.search(/[*?[]/);
    if (idx === -1) return pattern;
    const cut = pattern.slice(0, idx);
    const slash = cut.lastIndexOf("/");
    return slash >= 0 ? cut.slice(0, slash) : "";
}

/** Read a vault file and parse its YAML frontmatter. */
async function readFileFrontmatter(filePath, obsidianUrl, apiKey) {
    const url = `${obsidianUrl}/vault/${encodePath(filePath)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/markdown" } });
    if (!res.ok) return {};
    const text = await res.text();
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    try { return yaml.parse(match[1]) || {}; } catch { return {}; }
}

function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v != null) return [v];
    return [];
}

/**
 * Load and enrich all files for an entity type config entry.
 * Concurrency-limited frontmatter reads (only for load-all or post-phonetic candidates).
 */
async function buildEnrichedPool(entityTypeCfg, obsidianUrl, apiKey, concurrency = 20) {
    // Collect all file paths matching the globs
    const allPaths = (await Promise.all(
        entityTypeCfg.files.map((glob) => listFilesForGlob(glob, obsidianUrl, apiKey))
    )).flat();

    // Deduplicate
    const uniquePaths = [...new Set(allPaths)];

    if (uniquePaths.length <= LOAD_ALL_THRESHOLD) {
        // Load-all: read frontmatter for all files (they're few enough)
        const enriched = await enrichFiles(uniquePaths, obsidianUrl, apiKey, concurrency);
        return enriched;
    } else {
        // Phonetic path: return stub enriched files for pre-filtering.
        // Frontmatter is fetched lazily for survivors.
        // We index both the full basename AND the first word so that single-name
        // entities (e.g. "Rhys") can phonetically match "Rhys Duggan".
        return uniquePaths.map((path) => {
            const basename = path.replace(/.*\//, "").replace(/\.md$/, "");
            const firstWord = basename.split(/\s+/)[0];
            const encodings = [getPhoneticEncoding(basename)];
            if (firstWord !== basename) encodings.push(getPhoneticEncoding(firstWord));
            return { path, basename, aliases: [], misspellings: [], phoneticEncodings: encodings };
        });
    }
}

async function enrichFiles(paths, obsidianUrl, apiKey, concurrency = 20) {
    const enriched = [];
    for (let i = 0; i < paths.length; i += concurrency) {
        const batch = paths.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (path) => {
            const fm = await readFileFrontmatter(path, obsidianUrl, apiKey);
            const basename = path.replace(/.*\//, "").replace(/\.md$/, "");
            const aliases = toArray(fm.aliases);
            const misspellings = toArray(fm.misspellings);
            const phoneticEncodings = [basename, ...aliases, ...misspellings].map(getPhoneticEncoding);
            return { path, basename, aliases, misspellings, phoneticEncodings };
        }));
        enriched.push(...results);
    }
    return enriched;
}

// ── Entity tagging LLM ────────────────────────────────────────────────────────
async function callEntityTagger({ apiKey, text, entityTypes }) {
    const typeList = entityTypes.map((et) => `"${et.type}"`).join(", ");
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

    const userPrompt = `Tag every mention of the following entity types: ${typeList}.\nDo not tag pronouns or vague references.\n\n${text}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", temperature: 0, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json.choices[0].message.content.trim();
}

/** Parse <entity> tags from tagged text (mirrors autoWikilinkEngine.ts). */
function parseEntityTags(taggedText) {
    const regex = /<entity id="(.*?)" type="(.*?)">(.*?)<\/entity>/g;
    const entities = new Map();

    for (const line of taggedText.split(/\r?\n/)) {
        if (/^#+ /.test(line)) continue;
        let match;
        while ((match = regex.exec(line)) !== null) {
            const [, canonicalName, type, displayName] = match;
            const key = `${canonicalName}|||${type}`;
            if (!entities.has(key)) entities.set(key, { canonicalName, type, displayNames: new Set() });
            entities.get(key).displayNames.add(displayName);
        }
    }

    return [...entities.values()].map((e) => ({ ...e, displayNames: [...e.displayNames] }));
}

// ── Name narrowing LLM ────────────────────────────────────────────────────────
async function narrowCandidatesBatched({ apiKey, entities, candidates }) {
    if (entities.length === 0 || candidates.length === 0)
        return new Map(entities.map((e) => [`${e.canonicalName}|||${e.type}`, []]));

    const entityInfos = entities.map((e) => ({ canonicalName: e.canonicalName, displayNames: e.displayNames }));
    const candidateInfos = candidates.map((c) => ({ displayNames: [c.basename, ...c.aliases, ...c.misspellings], path: c.path }));

    const prompt = `
        You are an expert at matching entities by name, even with alternate spellings.
        Given a list of target entities and a shared list of candidate files, for each entity return
        the file paths that are plausible name matches.

        Rules:
        - If an entity has a full name, only include candidates whose name is a plausible alternate spelling.
        - If an entity is only referenced by a short or partial name, include all candidates that could match.
        - Do not include candidates whose names are clearly different, even if they share some words.

        Entities:
        ${entityInfos.map((e) => `  - canonicalName: ${JSON.stringify(e.canonicalName)}, displayNames: ${JSON.stringify(e.displayNames)}`).join("\n")}

        Candidates:
        ${candidateInfos.map((c) => `  - [${c.displayNames.join(", ")}] (${c.path})`).join("\n")}
    `.trim();

    const schema = {
        type: "object",
        properties: {
            results: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        canonicalName: { type: "string" },
                        matchingFilePaths: { type: "array", items: { type: "string" } },
                    },
                    required: ["canonicalName", "matchingFilePaths"],
                    additionalProperties: false,
                },
            },
        },
        required: ["results"],
        additionalProperties: false,
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "gpt-4.1-nano", temperature: 0,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_schema", json_schema: { name: "candidate_filter_batched", strict: true, schema } },
        }),
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const data = JSON.parse(json.choices[0].message.content);

    const resultMap = new Map();
    for (const entity of entities) {
        const key = `${entity.canonicalName}|||${entity.type}`;
        const match = data.results.find((r) => r.canonicalName === entity.canonicalName);
        const paths = match?.matchingFilePaths ?? [];
        resultMap.set(key, candidates.filter((c) => paths.includes(c.path)));
    }
    return resultMap;
}

// ── Resolution pipeline ───────────────────────────────────────────────────────
/**
 * Run resolution for a set of entities against their type pools.
 * Returns Map<canonicalName|||type, { candidates: [], narrowed: [] }>
 */
async function resolveEntities(entities, poolByType, apiKey, obsidianUrl, obsidianApiKey) {
    // Group entities by type
    const byType = new Map();
    for (const entity of entities) {
        const list = byType.get(entity.type) ?? [];
        list.push(entity);
        byType.set(entity.type, list);
    }

    const results = new Map();

    for (const [type, typeEntities] of byType) {
        let pool = poolByType.get(type) ?? [];

        if (pool.length === 0) {
            for (const e of typeEntities) results.set(`${e.canonicalName}|||${e.type}`, { pool: 0, candidates: [], narrowed: [] });
            continue;
        }

        const isLoadAll = pool.length <= LOAD_ALL_THRESHOLD;

        if (!isLoadAll) {
            // Phonetic pre-filtering per entity
            for (const entity of typeEntities) {
                const displayNameEncodings = entity.displayNames.map(getPhoneticEncoding);
                const phoneticCandidates = pool.filter((file) =>
                    displayNameEncodings.some((enc) =>
                        findBestPhoneticMatch(enc, file.phoneticEncodings) !== undefined
                    )
                );

                // Fetch full frontmatter for phonetic survivors (if we only have stubs)
                const enriched = await enrichFiles(
                    phoneticCandidates.map((c) => c.path),
                    obsidianUrl,
                    obsidianApiKey,
                    20,
                );

                // Single-entity name narrowing
                const narrowMap = await narrowCandidatesBatched({ apiKey, entities: [entity], candidates: enriched });
                const narrowed = narrowMap.get(`${entity.canonicalName}|||${entity.type}`) ?? [];
                results.set(`${entity.canonicalName}|||${entity.type}`, { pool: pool.length, candidates: enriched, narrowed });
            }
        } else {
            // Load-all: one batch narrowing call per type
            const narrowMap = await narrowCandidatesBatched({ apiKey, entities: typeEntities, candidates: pool });
            for (const entity of typeEntities) {
                const key = `${entity.canonicalName}|||${entity.type}`;
                const narrowed = narrowMap.get(key) ?? [];
                results.set(key, { pool: pool.length, candidates: pool, narrowed });
            }
        }
    }

    return results;
}

// ── Display helpers ───────────────────────────────────────────────────────────
function hr(char = "─", width = 60) { return char.repeat(width); }

function truncate(s, max = 70) {
    const oneLine = s.replace(/\n/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function basename(path) { return path.replace(/.*\//, "").replace(/\.md$/, ""); }

// ── Main processing ───────────────────────────────────────────────────────────
async function processEntry({
    entry, entryNum, totalEntries, apiKey, obsidianApiKey, obsidianUrl,
    entityTypesCfg, stripOnly, taggingOnly,
}) {
    const input = stripSectionStructure(entry.content);
    const inputParas = input.split(/\n\n/).filter(Boolean);

    const entryLabel = totalEntries > 1 ? ` (entry ${entryNum}/${totalEntries})` : "";
    console.log(`\n${BOLD}${CYAN}${hr("═")}${R}`);
    console.log(`${BOLD}${CYAN}  ## ${entry.title}${entryLabel}${R}`);
    console.log(`${BOLD}${CYAN}${hr("═")}${R}\n`);

    // Original wikilinks
    const originalLinks = parseOriginalWikilinks(entry.content);
    if (originalLinks.length > 0) {
        console.log(`${DIM}Original wikilinks (${originalLinks.length}):${R}`);
        for (const { target, display } of originalLinks) {
            const label = display !== target ? `${display}  ${DIM}→ ${target}${R}` : target;
            console.log(`  ${DIM}[[${label}]]${R}`);
        }
        console.log();
    } else {
        console.log(`${DIM}No wikilinks in original entry.${R}\n`);
    }

    if (stripOnly) {
        const stripped = stripWikilinks(input);
        console.log(`${DIM}Stripped input:${R}\n`);
        stripped.split(/\n\n/).forEach((p, i) => console.log(`  ${DIM}[${String(i).padStart(2)}]${R} ${truncate(p)}`));
        return;
    }

    // Entity tagging
    const stripped = stripWikilinks(input);
    console.log(`${DIM}Calling gpt-4.1 to tag entities...${R}`);
    let taggedText;
    try {
        taggedText = await callEntityTagger({ apiKey, text: stripped, entityTypes: entityTypesCfg });
    } catch (err) {
        console.error(`${BOLD}Tagging error:${R} ${err.message}`);
        return;
    }

    const taggedEntities = parseEntityTags(taggedText);

    if (taggedEntities.length === 0) {
        console.log(`${YELLOW}No entities tagged.${R}`);
        return;
    }

    console.log(`\n${BOLD}${GREEN}Tagged ${taggedEntities.length} entity/entities:${R}`);
    for (const e of taggedEntities) {
        const names = e.displayNames.length > 1 ? ` ${DIM}(as: ${e.displayNames.join(", ")})${R}` : "";
        console.log(`  ${GREEN}${e.type}:${R} ${e.canonicalName}${names}`);
    }

    // Compare tags vs original wikilinks.
    // Match by display name (case-insensitive): e.g. entity display "Rhys" matches original display "Rhys".
    // Also match by canonical name against original target.
    const originalByDisplay = new Map(originalLinks.map((l) => [l.display.toLowerCase(), l]));
    const originalByTarget = new Map(originalLinks.map((l) => [l.target.toLowerCase(), l]));

    const matchedOriginalTargets = new Set();
    for (const entity of taggedEntities) {
        for (const displayName of entity.displayNames) {
            const orig = originalByDisplay.get(displayName.toLowerCase());
            if (orig) { matchedOriginalTargets.add(orig.target); break; }
        }
        const byTarget = originalByTarget.get(entity.canonicalName.toLowerCase());
        if (byTarget) matchedOriginalTargets.add(byTarget.target);
    }

    // Entities that were linked in original but not tagged
    const missedLinks = originalLinks.filter((l) => !matchedOriginalTargets.has(l.target));
    // Entities tagged but not corresponding to any original link
    const originalDisplaySet = new Set(originalLinks.map((l) => l.display.toLowerCase()));
    const extraTags = taggedEntities.filter((e) =>
        !e.displayNames.some((d) => originalDisplaySet.has(d.toLowerCase())) &&
        !originalByTarget.has(e.canonicalName.toLowerCase())
    );

    if (missedLinks.length > 0) {
        console.log(`\n${YELLOW}Missed (in original but not tagged):${R}`);
        for (const l of missedLinks) console.log(`  ${YELLOW}  ${l.display} → [[${l.target}]]${R}`);
    }
    if (extraTags.length > 0) {
        console.log(`\n${BLUE}Extra (tagged but not in original):${R}`);
        for (const e of extraTags) console.log(`  ${BLUE}  ${e.type}: ${e.canonicalName}${R}`);
    }

    if (taggingOnly) {
        console.log(`\n${DIM}(--tagging-only: skipping resolution)${R}`);
        return;
    }

    if (!obsidianApiKey) {
        console.log(`\n${YELLOW}No Obsidian API key — skipping resolution. Use --obsidian-key or OBSIDIAN_API_KEY.${R}`);
        return;
    }

    // Load vault file pools
    console.log(`\n${DIM}Loading vault files...${R}`);
    const poolByType = new Map();
    for (const etCfg of entityTypesCfg) {
        process.stdout.write(`  ${DIM}${etCfg.type}: ${R}`);
        const pool = await buildEnrichedPool(etCfg, obsidianUrl, obsidianApiKey);
        poolByType.set(etCfg.type, pool);
        const isLoadAll = pool.length <= LOAD_ALL_THRESHOLD;
        console.log(`${pool.length} files  ${DIM}(${isLoadAll ? "load-all" : "phonetic"})${R}`);
    }

    // Run resolution
    console.log(`\n${DIM}Resolving entities...${R}`);
    let resolutionResults;
    try {
        resolutionResults = await resolveEntities(taggedEntities, poolByType, apiKey, obsidianUrl, obsidianApiKey);
    } catch (err) {
        console.error(`${BOLD}Resolution error:${R} ${err.message}`);
        return;
    }

    // Maps for looking up original links during result display
    const origByDisplayForResult = new Map(originalLinks.map((l) => [l.display.toLowerCase(), l.target]));
    const origByTargetForResult = new Map(originalLinks.map((l) => [l.target.toLowerCase(), l.target]));

    console.log(`\n${DIM}${hr()}${R}`);
    console.log(`${BOLD}Resolution results:${R}\n`);

    for (const entity of taggedEntities) {
        const key = `${entity.canonicalName}|||${entity.type}`;
        const res = resolutionResults.get(key);
        if (!res) continue;

        const { pool, narrowed } = res;

        // Find the original link this entity corresponds to (by canonical name or display name)
        const origLink = originalLinks.find((l) =>
            l.target.toLowerCase() === entity.canonicalName.toLowerCase() ||
            entity.displayNames.some((d) => d.toLowerCase() === l.display.toLowerCase())
        );

        // Determine result
        let status, resolved, extra = "";
        if (narrowed.length === 0) {
            status = `${RED}✗ UNMATCHED${R}`;
            resolved = origLink ? `${DIM}(expected: [[${origLink.target}]])${R}` : `${DIM}(not in original)${R}`;
        } else if (narrowed.length === 1) {
            const file = narrowed[0];
            const matchesOriginal = origLink && file.basename.toLowerCase() === origLink.target.toLowerCase();
            status = matchesOriginal ? `${GREEN}✓${R}` : `${YELLOW}~${R}`;
            resolved = file.basename;
            if (origLink && !matchesOriginal) extra = `  ${DIM}(expected: ${origLink.target})${R}`;
        } else {
            // Multiple candidates — show them all
            status = `${YELLOW}? AMBIGUOUS${R}`;
            resolved = narrowed.map((f) => {
                const isExpected = origLink && f.basename.toLowerCase() === origLink.target.toLowerCase();
                return isExpected ? `${GREEN}${f.basename}${R}` : f.basename;
            }).join(", ");
            if (origLink) extra = `  ${DIM}(expected: ${origLink.target})${R}`;
        }

        const typeTag = `${DIM}[${entity.type}]${R}`;
        const displayNames = entity.displayNames.length > 1 ? ` ${DIM}(as: ${entity.displayNames.join(", ")})${R}` : "";
        const poolInfo = `${DIM}pool:${pool}${R}`;
        console.log(`  ${status} ${typeTag} ${entity.canonicalName}${displayNames}  →  ${resolved}${extra}  ${poolInfo}`);
    }
    console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.files.length === 0) {
        console.error(`${BOLD}Error:${R} No input files specified. Run with --help for usage.`);
        process.exit(1);
    }

    const dataJson = (() => { try { return JSON.parse(readFileSync(DATA_JSON, "utf8")); } catch { return {}; } })();
    const restApiDataJson = (() => { try { return JSON.parse(readFileSync(LOCAL_REST_API_DATA_JSON, "utf8")); } catch { return {}; } })();
    const apiKey = process.env.OPENAI_API_KEY || dataJson.openaiKey;
    const obsidianApiKey = opts.obsidianKey || process.env.OBSIDIAN_API_KEY || dataJson.obsidianApiKey || restApiDataJson.apiKey;
    const obsidianUrl = (opts.obsidianUrl || DEFAULT_OBSIDIAN_URL).replace(/\/$/, "");

    if (!apiKey && !opts.stripOnly) {
        console.error(`${BOLD}Error:${R} No OpenAI API key. Set OPENAI_API_KEY or ensure data.json has openaiKey.`);
        process.exit(1);
    }

    const configPath = opts.configPath ?? DEFAULT_YAML_CONFIG;
    const { entityTypes: entityTypesCfg } = readWikilinkConfig(configPath);

    for (const filePath of opts.files) {
        const resolvedPath = resolve(filePath);
        if (!existsSync(resolvedPath)) {
            console.error(`${BOLD}Error:${R} File not found: ${resolvedPath}`);
            continue;
        }

        const raw = readFileSync(resolvedPath, "utf8");
        const entries = splitIntoEntries(stripFrontmatter(raw));

        if (entries.length === 0) {
            console.error(`No entries found in ${filePath}`);
            continue;
        }

        if (opts.entry === null && !opts.all && !opts.stripOnly) {
            console.log(`\n${BOLD}${CYAN}${filePath}${R} — ${entries.length} entry/entries:\n`);
            entries.forEach((e, i) => {
                const linkCount = parseOriginalWikilinks(e.content).length;
                console.log(`  ${BOLD}${i + 1}.${R} ${e.title}  ${DIM}(${linkCount} wikilinks)${R}`);
            });
            console.log(`\n${DIM}Run with --entry <n> to process one, or --all to process all.${R}\n`);
            continue;
        }

        let toProcess;
        if (opts.all || opts.stripOnly) {
            toProcess = entries.map((e, i) => ({ entry: e, entryNum: i + 1 }));
        } else {
            const idx = opts.entry - 1;
            if (idx < 0 || idx >= entries.length) {
                console.error(`${BOLD}Error:${R} --entry ${opts.entry} out of range (file has ${entries.length} entries)`);
                continue;
            }
            toProcess = [{ entry: entries[idx], entryNum: opts.entry }];
        }

        for (const { entry, entryNum } of toProcess) {
            await processEntry({
                entry, entryNum, totalEntries: entries.length,
                apiKey, obsidianApiKey, obsidianUrl,
                entityTypesCfg, stripOnly: opts.stripOnly, taggingOnly: opts.taggingOnly,
            });
        }
    }
}

main().catch((err) => {
    console.error(`${BOLD}Fatal error:${R}`, err.message);
    process.exit(1);
});
