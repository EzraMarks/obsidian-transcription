#!/usr/bin/env node
/**
 * iterate-headers.mjs — Dev tool for iterating on the journal_headers prompt.
 *
 * Each ## header in a journal file is one entry (one day's recording). This script
 * splits the file by those ## boundaries, strips the ###/#### section headers that
 * the pipeline added, and re-runs the add_headers prompt so you can iterate on it
 * without re-transcribing anything.
 *
 * Usage:
 *   node scripts/iterate-headers.mjs [OPTIONS] <journal.md> [journal2.md ...]
 *
 * Options:
 *   --entry <n>        Process only entry N (1-based). Without this, lists entries and exits.
 *   --all              Process all entries in each file.
 *   --config <path>    YAML pipeline config (default: referenceConfiguration/journalTranscription.yaml)
 *   --prompt <file>    Override system prompt with a plain text file
 *   --model <name>     Override model name
 *   --temp <n>         Override temperature
 *   --strip-only       Print stripped+numbered input without calling the API
 *   --show-prompt      Print the system prompt before processing
 *   --help             Show this help
 *
 * API key: reads OPENAI_API_KEY env var, or falls back to data.json in the plugin dir.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "..");
const DEFAULT_YAML_CONFIG = resolve(PLUGIN_DIR, "referenceConfiguration/journalTranscription.yaml");
const DATA_JSON = resolve(PLUGIN_DIR, "data.json");

// ── ANSI colors ──────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";

// ── CLI arg parsing ───────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = {
        configPath: null, promptFile: null, model: null, temp: null,
        entry: null, all: false, stripOnly: false, showPrompt: false, files: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--config") opts.configPath = argv[++i];
        else if (a === "--prompt" || a === "-p") opts.promptFile = argv[++i];
        else if (a === "--model" || a === "-m") opts.model = argv[++i];
        else if (a === "--temp" || a === "-t") opts.temp = parseFloat(argv[++i]);
        else if (a === "--entry" || a === "-e") opts.entry = parseInt(argv[++i], 10);
        else if (a === "--all" || a === "-a") opts.all = true;
        else if (a === "--strip-only" || a === "-s") opts.stripOnly = true;
        else if (a === "--show-prompt") opts.showPrompt = true;
        else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
        else if (!a.startsWith("-")) opts.files.push(a);
    }
    return opts;
}

function printHelp() {
    console.log(`
${BOLD}iterate-headers.mjs${R} — Iterate on the add_headers journal prompt

${BOLD}Usage:${R}
  node scripts/iterate-headers.mjs [OPTIONS] <journal.md> [journal2.md ...]

${BOLD}Options:${R}
  --entry <n>        Process only entry N (1-based index shown in the entry list)
  --all              Process all entries (makes one API call per entry)
  --config <path>    YAML pipeline config to read system_prompt from
                     (default: referenceConfiguration/journalTranscription.yaml)
  --prompt <file>    Override system prompt with a plain text file
  --model <name>     Override model name
  --temp <n>         Override temperature
  --strip-only       Print stripped+numbered input, skip API call
  --show-prompt      Print the system prompt before processing
  --help             Show this help

${BOLD}Workflow:${R}
  1. Run without --entry to see the list of entries in a file.
  2. Pick one: node scripts/iterate-headers.mjs --entry 3 journal.md
  3. Edit the system_prompt in journalTranscription.yaml and re-run.

${BOLD}API key:${R} OPENAI_API_KEY env var, or data.json in the plugin directory.
`);
}

// ── Read config from YAML ─────────────────────────────────────────────────────
function readHeadersConfig(configPath) {
    const content = readFileSync(configPath, "utf8");
    const parsed = yaml.parse(content);
    const step = parsed.steps?.find((s) => s.type === "add_headers");
    if (!step) throw new Error(`No add_headers step found in ${configPath}`);
    return { systemPrompt: step.system_prompt, model: step.model.name, temperature: step.model.temperature };
}

// ── Text processing ───────────────────────────────────────────────────────────

/** Strip YAML frontmatter (---...---) */
function stripFrontmatter(text) {
    return text.replace(/^---[\s\S]*?---\s*\n?/, "").trim();
}

/**
 * Split a journal file into individual day entries using ## headers as boundaries.
 * Returns [{ title, content }] where content is the raw text under that ## header.
 * If there are no ## headers, the whole file is treated as one unnamed entry.
 */
function splitIntoEntries(text) {
    const lines = text.split("\n");
    const entries = [];
    let currentTitle = null;
    let currentLines = [];

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
 * Strip ###/#### section headers and standalone Obsidian embeds from one entry's
 * content to recover the "journal_cleanup" text that add_headers would receive.
 */
function stripSectionStructure(text) {
    const paragraphs = text.split(/\n\n+/);
    const kept = paragraphs.filter((p) => {
        const trimmed = p.trim();
        if (!trimmed) return false;
        if (/^#{3,6}\s/.test(trimmed)) return false; // ###+ headers added by pipeline
        if (/^!\[\[.*\]\]\s*$/.test(trimmed)) return false; // standalone Obsidian embed
        return true;
    });
    return kept.join("\n\n");
}

/** Same header-insertion logic as pipelineEngine.ts */
function insertHeaders(text, headers) {
    const paragraphs = text.split(/\n\n/);
    const sorted = [...headers].sort((a, b) => b.before_paragraph - a.before_paragraph || a.level - b.level);
    for (const h of sorted) {
        const idx = Math.max(0, Math.min(h.before_paragraph, paragraphs.length));
        paragraphs.splice(idx, 0, "#".repeat(h.level) + " " + h.title);
    }
    return paragraphs.join("\n\n");
}

// ── OpenAI call ───────────────────────────────────────────────────────────────
async function callOpenAIStructured({ apiKey, systemPrompt, userPrompt, model, temperature }) {
    const schema = {
        type: "object",
        properties: {
            headers: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        level: { type: "integer", enum: [3, 4] },
                        title: { type: "string" },
                        before_paragraph: { type: "integer", minimum: 0 },
                    },
                    required: ["level", "title", "before_paragraph"],
                    additionalProperties: false,
                },
            },
        },
        required: ["headers"],
        additionalProperties: false,
    };

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            temperature,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_schema", json_schema: { name: "add_headers", strict: true, schema } },
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const json = await res.json();
    return JSON.parse(json.choices[0].message.content);
}

// ── Display helpers ───────────────────────────────────────────────────────────
function hr(char = "─", width = 60) { return char.repeat(width); }

function truncate(s, max = 80) {
    const oneLine = s.replace(/\n/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

async function processEntry({ entry, entryNum, totalEntries, apiKey, systemPrompt, model, temperature, stripOnly }) {
    const stripped = stripSectionStructure(entry.content);
    const paragraphs = stripped.split(/\n\n/);

    const entryLabel = totalEntries > 1 ? ` (entry ${entryNum}/${totalEntries})` : "";
    console.log(`\n${BOLD}${CYAN}${hr("═")}${R}`);
    console.log(`${BOLD}${CYAN}  ## ${entry.title}${entryLabel}${R}`);
    console.log(`${BOLD}${CYAN}  ${paragraphs.length} paragraphs after stripping${R}`);
    console.log(`${BOLD}${CYAN}${hr("═")}${R}\n`);

    console.log(`${DIM}Paragraph map:${R}`);
    paragraphs.forEach((p, i) => {
        console.log(`  ${DIM}[${String(i).padStart(2)}]${R} ${truncate(p)}`);
    });

    if (stripOnly) {
        console.log(`\n${DIM}(--strip-only: skipping API call)${R}`);
        return;
    }

    console.log(`\n${DIM}Calling ${model} (temp=${temperature})...${R}`);

    let result;
    try {
        result = await callOpenAIStructured({ apiKey, systemPrompt, userPrompt: stripped, model, temperature });
    } catch (err) {
        console.error(`${BOLD}API error:${R} ${err.message}`);
        return;
    }

    console.log(`\n${BOLD}${GREEN}Generated ${result.headers.length} header(s):${R}`);
    for (const h of result.headers) {
        const indent = h.level === 4 ? "    " : "  ";
        console.log(`${indent}${GREEN}${"#".repeat(h.level)} ${h.title}${R}  ${DIM}→ before [${h.before_paragraph}]${R}`);
    }

    const output = insertHeaders(stripped, result.headers);
    console.log(`\n${DIM}${hr()}${R}`);
    console.log(`${BOLD}Output:${R}\n`);
    for (const p of output.split(/\n\n/)) {
        if (/^#{3,4}\s/.test(p)) {
            console.log(`${BOLD}${YELLOW}${p}${R}\n`);
        } else {
            console.log(`${DIM}${p}${R}\n`);
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.files.length === 0) {
        console.error(`${BOLD}Error:${R} No input files specified. Run with --help for usage.`);
        process.exit(1);
    }

    const apiKey = process.env.OPENAI_API_KEY || (() => {
        try { return JSON.parse(readFileSync(DATA_JSON, "utf8")).openaiKey; } catch { return null; }
    })();
    if (!apiKey && !opts.stripOnly) {
        console.error(`${BOLD}Error:${R} No OpenAI API key. Set OPENAI_API_KEY or ensure data.json has openaiKey.`);
        process.exit(1);
    }

    const configPath = opts.configPath ?? DEFAULT_YAML_CONFIG;
    let systemPrompt, defaultModel, defaultTemp;

    if (opts.promptFile) {
        systemPrompt = readFileSync(resolve(opts.promptFile), "utf8").trim();
        defaultModel = "gpt-4.1";
        defaultTemp = 0.3;
    } else {
        const cfg = readHeadersConfig(configPath);
        systemPrompt = cfg.systemPrompt;
        defaultModel = cfg.model;
        defaultTemp = cfg.temperature;
    }

    const model = opts.model ?? defaultModel;
    const temperature = opts.temp ?? defaultTemp;

    if (opts.showPrompt) {
        console.log(`\n${BOLD}${MAGENTA}System prompt:${R}\n${DIM}${hr()}${R}`);
        console.log(systemPrompt.trim());
        console.log(`${DIM}${hr()}${R}\n`);
    }

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

        // No --entry and no --all: just list available entries
        if (opts.entry === null && !opts.all && !opts.stripOnly) {
            console.log(`\n${BOLD}${CYAN}${filePath}${R} — ${entries.length} entry/entries:\n`);
            entries.forEach((e, i) => {
                const paragraphCount = stripSectionStructure(e.content).split(/\n\n/).filter(Boolean).length;
                console.log(`  ${BOLD}${i + 1}.${R} ${e.title}  ${DIM}(${paragraphCount} paragraphs)${R}`);
            });
            console.log(`\n${DIM}Run with --entry <n> to process one, or --all to process all.${R}\n`);
            continue;
        }

        // Determine which entries to process
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
            await processEntry({ entry, entryNum, totalEntries: entries.length, apiKey, systemPrompt, model, temperature, stripOnly: opts.stripOnly });
        }
    }
}

main().catch((err) => {
    console.error(`${BOLD}Fatal error:${R}`, err.message);
    process.exit(1);
});
