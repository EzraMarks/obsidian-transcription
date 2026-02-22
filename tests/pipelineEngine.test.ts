/**
 * Integration tests for the journal pipeline steps.
 *
 * Prerequisites: same as autoWikilinkEngine.test.ts
 *   - Obsidian open with plugin in testMode (set testMode: true in data.json, rebuild)
 *   - OpenAI API key in data.json or OPENAI_API_KEY env var
 *
 * What this tests:
 *   - audio_transcription → journal_cleanup → journal_headers on real vault recordings
 *
 * Outputs are saved to tests/scratch/<recording-basename>/:
 *   01-transcript.txt  — raw Whisper output
 *   02-cleanup.txt     — after journal_cleanup
 *   03-headers.txt     — after journal_headers
 *
 * If 01-transcript.txt already exists for a recording, the expensive transcription
 * step is skipped and the cached version is used. Delete it to re-transcribe.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { TFile } from "obsidian";
import { PipelineEngine } from "src/pipelineEngine";

// Auto-accept the resolve-entity modal — these tests don't run the wikilink step
// but the import chain still pulls in ResolveEntityModal.
vi.mock("src/resolveEntityModal", () => ({
    ResolveEntityModal: class {
        constructor(
            private _app: unknown,
            private selections: unknown[],
            private _allFiles: unknown,
            private _fileTypeTags: unknown,
            private _utilsEngine: unknown,
            private onComplete: (s: unknown[]) => void,
        ) {}
        open() { this.onComplete(this.selections); }
    },
}));
import { DEFAULT_SETTINGS } from "src/settings";
import { TEST_SERVER_PORT } from "src/testServer";

// ── Paths ─────────────────────────────────────────────────────────────────────
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_DIR = resolve(PLUGIN_DIR, "tests/scratch");

function scratchPath(basename: string, filename: string): string {
    const dir = resolve(SCRATCH_DIR, basename);
    mkdirSync(dir, { recursive: true });
    return resolve(dir, filename);
}

// ── Settings ──────────────────────────────────────────────────────────────────
const settings = {
    ...DEFAULT_SETTINGS,
    openaiKey: (() => {
        const p = resolve(PLUGIN_DIR, "data.json");
        return existsSync(p)
            ? (JSON.parse(readFileSync(p, "utf8")).openaiKey ?? "")
            : (process.env.OPENAI_API_KEY ?? "");
    })(),
};

// ── Test server helpers ───────────────────────────────────────────────────────
const TEST_SERVER = `http://127.0.0.1:${TEST_SERVER_PORT}`;

async function serverGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, TEST_SERVER);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Test server ${res.status}: ${path}`);
    return res.json() as Promise<T>;
}

async function serverGetText(path: string, params?: Record<string, string>): Promise<string> {
    const url = new URL(path, TEST_SERVER);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Test server ${res.status}: ${path}`);
    return res.text();
}

async function serverGetBinary(path: string, params?: Record<string, string>): Promise<ArrayBuffer> {
    const url = new URL(path, TEST_SERVER);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Test server ${res.status}: ${path}`);
    return res.arrayBuffer();
}

type FileEntry = { path: string; basename: string; extension: string; mtime: number };

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeTFile(path: string): TFile {
    return new (TFile as any)(path) as TFile;
}

/** Wrap YAML in the markdown code-block that parsePipelineDefinition expects. */
function pipelineDoc(yaml: string): string {
    return "```yaml\n" + yaml.trimEnd() + "\n```";
}

/**
 * Build a mock vault/app for a single pipeline step.
 *
 * - "pipeline.md"    → pipelineYaml (in-memory)
 * - "test-input.txt" → textInput, if provided (for file_content pipeline inputs)
 * - Any other path   → forwarded to the test server
 *   - Text reads via GET /file, binary reads via GET /file-binary
 */
function buildStepEnv(pipelineYaml: string, textInput?: string) {
    const vault = {
        getFileByPath: (path: string): TFile | null => makeTFile(path),
        read: async (file: TFile): Promise<string> => {
            if (file.path === "pipeline.md") return pipelineDoc(pipelineYaml);
            if (file.path === "test-input.txt" && textInput !== undefined) return textInput;
            return serverGetText("/file", { path: file.path });
        },
        cachedRead: (file: TFile) => vault.read(file),
        readBinary: (file: TFile) => serverGetBinary("/file-binary", { path: file.path }),
        create: async () => {
            throw new Error("vault.create not supported in tests");
        },
        getFolderByPath: () => null,
    };
    const app = {
        vault,
        metadataCache: {
            getFileCache: () => null,
            getBacklinksForFile: () => ({ data: new Map() }),
        },
        fileManager: { processFrontMatter: async () => {} },
    };
    return { vault, app };
}

function makeEngine(pipelineYaml: string, textInput?: string): PipelineEngine {
    const { vault, app } = buildStepEnv(pipelineYaml, textInput);
    return new PipelineEngine(settings, vault as any, null, app as any);
}

// ── Step runners ──────────────────────────────────────────────────────────────

async function runTranscriptionStep(audioPath: string): Promise<string> {
    const yaml = `\
steps:
  - name: transcription
    type: audio_transcription
    description: Transcribe the audio file
    file: "{{ input_file }}"
`;
    const engine = makeEngine(yaml);
    return engine.runPipeline(makeTFile("active.md"), makeTFile(audioPath), makeTFile("pipeline.md"));
}

async function runCleanupStep(transcript: string): Promise<string> {
    const yaml = `\
inputs:
  - name: transcription
    type: file_content
    file: test-input.txt
steps:
  - name: journal_cleanup
    type: llm
    description: Remove filler words and fix formatting
    model:
      name: gpt-4.1
      temperature: 0
    prompt:
      - role: system
        content: |
          You are proofreading a journal transcript from an audio-to-text model (GPT-4o).

          Your instructions:

          - **Keep all my original words and tone.**
          - **Remove only filler words** like "um," "uh," "like" (when unnecessary), "you know," etc.
          - **Fix formatting**:
            - Break text into frequent, natural-sized paragraphs, following topic shifts. Avoid very long paragraphs (no more than 200 words).
            - Italicize titles of books, films, albums, and other works.
          - **Do not** reword, paraphrase, or remove ANY content aside from disfluencies and changing punctuation.
      - role: user
        content: "{{ transcription }}"
`;
    const engine = makeEngine(yaml, transcript);
    return engine.runPipeline(makeTFile("active.md"), makeTFile("audio.mp3"), makeTFile("pipeline.md"));
}

async function runHeadersStep(cleanedText: string): Promise<string> {
    const yaml = `\
inputs:
  - name: journal_cleanup
    type: file_content
    file: test-input.txt
steps:
  - name: journal_headers
    type: add_headers
    description: Add section headers
    input: "{{ journal_cleanup }}"
    model:
      name: gpt-4.1
      temperature: 0
    system_prompt: |
      You analyze a journal entry and identify where to place Markdown headers.

      Each header title should spark recognition when skimming weeks later. A simple label is fine for routine segments. Only add a specific detail when it's genuinely insightful or memorable — not just to fill space, note who happened to be present, or add commentary about an activity that already speaks for itself.

      FORMATTING:
      - Use standard Title Case: capitalize major words; keep articles, short prepositions, and conjunctions (a, an, the, in, on, at, to, of, for, with, and, but, or) lowercase unless they start the title.
      - Keep titles concise: 3-5 words, 6 at most. Name the single dominant subject directly — skip framing words like "Reflections", "Thoughts", or activity verbs like "Watching" or "Making".
      - Describe what happened — name the activity or subject directly. Do not interpret or impose a frame on the author's experience.
      - If a paragraph opens with a brief routine activity (like going to the gym) before moving on to the real content, ignore the routine activity in the title.
      - When an activity is shared with a specific person, include their name.

      PLACEMENT:
      - Add a level-3 header (###) for each major block of the day — things like the workday, an evening at home, dinner out, or a social event. A typical day has 2-4 sections, though complex days may have more. Minor location changes within a block do not create a new section.
      - A shift in subject, mood, or topic is never a section boundary.
      - Err strongly on the side of fewer sections. A single paragraph at the end of an entry doesn't need its own section unless it clearly introduces a new activity or topic.
      - Add level-4 sub-headers (####) only for a specific, self-contained incident that clearly interrupts or stands apart from the surrounding activity. These should be rare.
      - Do not add a header before paragraph 0 if it is a short date/time preamble.
`;
    const engine = makeEngine(yaml, cleanedText);
    return engine.runPipeline(makeTFile("active.md"), makeTFile("audio.mp3"), makeTFile("pipeline.md"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Recordings to test — basenames without extension, as they appear in Obsidian wikilinks
const TARGET_RECORDINGS = [
    "recording-name-1",
    "recording-name-2",
];

describe("PipelineEngine — real recordings", () => {
    let allRecordings: FileEntry[] = [];

    beforeAll(async () => {
        await serverGet("/health").catch(() => {
            throw new Error(
                "Test server not reachable at " + TEST_SERVER + ". " +
                "Set testMode: true in data.json and rebuild the plugin.",
            );
        });

        allRecordings = await serverGet<FileEntry[]>("/files", { glob: "**/*.m4a", all: "1" });
        console.log(`Found ${allRecordings.length} .m4a file(s) in vault.`);
    });

    for (const basename of TARGET_RECORDINGS) {
        it(`transcription → cleanup → headers: ${basename}`, async () => {
            const entry = allRecordings.find((f) => f.basename === basename);
            if (!entry) {
                console.warn(`Skipping: recording not found in vault: ${basename}`);
                return;
            }

            console.log(`\n══ ${basename} ══════════════════════════════`);

            const p1 = scratchPath(basename, "01-transcript.txt");
            const p2 = scratchPath(basename, "02-cleanup.txt");
            const p3 = scratchPath(basename, "03-headers.txt");

            // ── Step 1: Transcription (cached if already done) ───────────────
            let transcript: string;
            if (existsSync(p1)) {
                transcript = readFileSync(p1, "utf8");
                console.log(`\n── Step 1: audio_transcription (cached) ──\n${transcript}`);
            } else {
                console.log("\n── Step 1: audio_transcription ──");
                transcript = await runTranscriptionStep(entry.path);
                writeFileSync(p1, transcript, "utf8");
                console.log(transcript);
            }
            expect(transcript.length).toBeGreaterThan(50);

            // ── Step 2: Cleanup ──────────────────────────────────────────────
            console.log("\n── Step 2: journal_cleanup ──");
            const cleaned = await runCleanupStep(transcript);
            writeFileSync(p2, cleaned, "utf8");
            console.log(cleaned);
            expect(cleaned.length).toBeGreaterThan(50);

            // ── Step 3: Headers ──────────────────────────────────────────────
            console.log("\n── Step 3: journal_headers ──");
            const headered = await runHeadersStep(cleaned);
            writeFileSync(p3, headered, "utf8");
            console.log(headered);

            expect(headered).toMatch(/^###/m);
            const h3Count = (headered.match(/^###\s/gm) ?? []).length;
            expect(h3Count).toBeGreaterThanOrEqual(1);
            expect(h3Count).toBeLessThanOrEqual(6);
        }, 10 * 60 * 1000); // 10-minute timeout for full pipeline
    }
});
