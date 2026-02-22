#!/usr/bin/env node
/**
 * iterate-cleanup.mjs — Iterate on the journal_cleanup prompt.
 *
 * Reconstructs the pre-cleanup text (by stripping section headers and wikilinks
 * from a processed entry), runs it through the cleanup LLM, and shows a diff
 * against the original to highlight what changed.  Running on already-cleaned
 * text is an idempotency test: differences reveal unintended behaviour.
 *
 * Usage:
 *   node scripts/iterate-cleanup.mjs [OPTIONS] <journal.md> [...]
 *
 * Options:
 *   --entry <n>     Process only entry N (1-based). Without this, lists entries.
 *   --all           Process all entries.
 *   --config <path> YAML pipeline config (default: referenceConfiguration/journalTranscription.yaml)
 *   --strip-only    Print stripped input without calling the API.
 *   --show-prompt   Print the cleanup system prompt before processing.
 *   --help          Show this help.
 *
 * API key: OPENAI_API_KEY env var, or data.json in the plugin directory.
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
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

// ── CLI arg parsing ───────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = {
        configPath: null, entry: null, all: false,
        stripOnly: false, showPrompt: false, files: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--config") opts.configPath = argv[++i];
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
${BOLD}iterate-cleanup.mjs${R} — Iterate on the journal_cleanup prompt

${BOLD}Usage:${R}
  node scripts/iterate-cleanup.mjs [OPTIONS] <journal.md> [...]

${BOLD}Options:${R}
  --entry <n>     Process only entry N (1-based index shown in the entry list)
  --all           Process all entries
  --config <path> YAML pipeline config
                  (default: referenceConfiguration/journalTranscription.yaml)
  --strip-only    Print stripped input without calling the API
  --show-prompt   Print the cleanup system prompt before processing
  --help          Show this help

${BOLD}How it works:${R}
  Strips ###/#### section headers and [[wikilinks]] from the processed entry to
  reconstruct what the raw transcript looked like, then re-runs the cleanup LLM.
  Showing the diff against the (also-stripped) original is an idempotency test.

${BOLD}API key:${R} OPENAI_API_KEY env var, or data.json in the plugin directory.
`);
}

// ── Config ───────────────────────────────────────────────────────────────────
function readCleanupConfig(configPath) {
    const content = readFileSync(configPath, "utf8");
    const parsed = yaml.parse(content);
    const step = parsed.steps?.find((s) => s.type === "llm");
    if (!step) throw new Error(`No llm step found in ${configPath}`);
    return { prompts: step.prompt, model: step.model.name, temperature: step.model.temperature };
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
 * Reconstruct pre-cleanup input: strip ###/#### headers, standalone embeds,
 * and wikilinks (all added by steps that run AFTER cleanup).
 */
function reconstructInput(text) {
    const paragraphs = text.split(/\n\n+/);
    const kept = paragraphs.filter((p) => {
        const t = p.trim();
        if (!t) return false;
        if (/^#{3,6}\s/.test(t)) return false;
        if (/^!\[\[.*\]\]\s*$/.test(t)) return false;
        return true;
    });
    return kept
        .map((p) => p.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => display || target))
        .join("\n\n");
}

// Normalise a paragraph for approximate comparison (ignore filler-word removal,
// minor punctuation tweaks, and capitalisation changes).
function normalise(text) {
    return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * LCS-based paragraph diff with normalised comparison.
 * Returns [{type: 'same'|'removed'|'added', ...}]
 */
function diffParagraphs(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = normalise(a[i - 1]) === normalise(b[j - 1])
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);

    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && normalise(a[i - 1]) === normalise(b[j - 1])) {
            result.unshift({ type: "same", original: a[i - 1], output: b[j - 1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: "added", text: b[j - 1] }); j--;
        } else {
            result.unshift({ type: "removed", text: a[i - 1] }); i--;
        }
    }

    // Pair adjacent removed+added as "changed"
    const paired = [];
    for (let k = 0; k < result.length; k++) {
        if (result[k].type === "removed" && k + 1 < result.length && result[k + 1].type === "added") {
            paired.push({ type: "changed", removed: result[k].text, added: result[k + 1].text });
            k++;
        } else {
            paired.push(result[k]);
        }
    }
    return paired;
}

function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
}

// ── Display helpers ───────────────────────────────────────────────────────────
function hr(char = "─", width = 60) { return char.repeat(width); }

function truncate(s, max = 80) {
    const oneLine = s.replace(/\n/g, " ").trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

// ── OpenAI call ───────────────────────────────────────────────────────────────
async function callCleanupLLM({ apiKey, prompts, userContent, model, temperature }) {
    const messages = prompts.map((p) => ({
        role: p.role,
        content: p.content.includes("{{ transcription }}")
            ? p.content.replace("{{ transcription }}", userContent)
            : p.content,
    }));

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature, messages }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }
    const json = await res.json();
    return json.choices[0].message.content.trim();
}

// ── Main processing ───────────────────────────────────────────────────────────
async function processEntry({ entry, entryNum, totalEntries, apiKey, prompts, model, temperature, stripOnly }) {
    const input = reconstructInput(entry.content);
    const inputParas = input.split(/\n\n/);

    const entryLabel = totalEntries > 1 ? ` (entry ${entryNum}/${totalEntries})` : "";
    console.log(`\n${BOLD}${CYAN}${hr("═")}${R}`);
    console.log(`${BOLD}${CYAN}  ## ${entry.title}${entryLabel}${R}`);
    console.log(`${BOLD}${CYAN}  ${inputParas.length} paragraphs after stripping${R}`);
    console.log(`${BOLD}${CYAN}${hr("═")}${R}\n`);

    console.log(`${DIM}Paragraph map:${R}`);
    inputParas.forEach((p, i) => {
        console.log(`  ${DIM}[${String(i).padStart(2)}]${R} ${truncate(p)}`);
    });

    if (stripOnly) {
        console.log(`\n${DIM}(--strip-only: skipping API call)${R}`);
        return;
    }

    console.log(`\n${DIM}Calling ${model} (temp=${temperature})...${R}`);

    let output;
    try {
        output = await callCleanupLLM({ apiKey, prompts, userContent: input, model, temperature });
    } catch (err) {
        console.error(`${BOLD}API error:${R} ${err.message}`);
        return;
    }

    const outputParas = output.split(/\n\n/);
    const diff = diffParagraphs(inputParas, outputParas);
    const changes = diff.filter((d) => d.type !== "same");

    console.log(`\n${DIM}${hr()}${R}`);
    console.log(`${BOLD}Output (diff vs reconstructed input):${R}\n`);

    for (const item of diff) {
        switch (item.type) {
            case "same":
                // Show output version (may have minor punctuation/spelling tweaks)
                console.log(`${DIM}${item.output}${R}\n`);
                break;
            case "changed":
                console.log(`${RED}─ ${item.removed}${R}\n`);
                console.log(`${GREEN}+ ${item.added}${R}\n`);
                break;
            case "removed":
                console.log(`${RED}─ ${item.text}${R}\n`);
                break;
            case "added":
                console.log(`${GREEN}+ ${item.text}${R}\n`);
                break;
        }
    }

    const inWords = wordCount(input), outWords = wordCount(output);
    const delta = outWords - inWords;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;

    if (changes.length === 0) {
        console.log(`${GREEN}✓ Idempotent — no substantive changes${R}  ${DIM}(${inWords} words)${R}`);
    } else {
        const pct = Math.round(changes.length / diff.length * 100);
        console.log(`${YELLOW}${changes.length}/${diff.length} paragraph(s) changed (${pct}%) — ${inWords} → ${outWords} words (${deltaStr})${R}`);
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
    const { prompts, model, temperature } = readCleanupConfig(configPath);

    if (opts.showPrompt) {
        const sys = prompts.find((p) => p.role === "system")?.content ?? "(no system prompt)";
        console.log(`\n${BOLD}${MAGENTA}System prompt:${R}\n${DIM}${hr()}${R}`);
        console.log(sys.trim());
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

        if (opts.entry === null && !opts.all && !opts.stripOnly) {
            console.log(`\n${BOLD}${CYAN}${filePath}${R} — ${entries.length} entry/entries:\n`);
            entries.forEach((e, i) => {
                const paraCount = reconstructInput(e.content).split(/\n\n/).filter(Boolean).length;
                console.log(`  ${BOLD}${i + 1}.${R} ${e.title}  ${DIM}(${paraCount} paragraphs)${R}`);
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
            await processEntry({ entry, entryNum, totalEntries: entries.length, apiKey, prompts, model, temperature, stripOnly: opts.stripOnly });
        }
    }
}

main().catch((err) => {
    console.error(`${BOLD}Fatal error:${R}`, err.message);
    process.exit(1);
});
