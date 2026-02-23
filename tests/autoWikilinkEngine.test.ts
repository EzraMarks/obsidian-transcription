/**
 * Integration test for AutoWikilinkEngine.
 *
 * Prerequisites:
 *   - Obsidian must be open with the plugin loaded in testMode.
 *     Set `"testMode": true` in data.json and rebuild the plugin.
 *     This starts the test server on http://127.0.0.1:27125.
 *   - OpenAI API key must be present in data.json as `openaiKey`.
 *
 * What this test does:
 *   - Imports the real AutoWikilinkEngine TypeScript code
 *   - obsidian is stubbed via __mocks__/obsidian.ts (requestUrl → fetch)
 *   - ResolveEntityModal is mocked to auto-accept AI selections
 *   - vault, metadataCache, and backlinks are served by the plugin test server,
 *     giving access to real Obsidian state including backlink counts
 *   - OpenAI calls go through normally
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { TFile } from "obsidian";
import { AutoWikilinkEngine } from "src/engines/autoWikilinkEngine";
import type { EntityTypeConfig } from "src/engines/autoWikilinkEngine";
import { DEFAULT_SETTINGS } from "src/settings";
import type { TranscriptionSettings } from "src/settings";
import { TEST_SERVER_PORT } from "src/testServer";

// ── Mock: auto-accept the resolve-entity modal ────────────────────────────────
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
        open() {
            this.onComplete(this.selections);
        }
    },
}));

// ── Test server client ────────────────────────────────────────────────────────
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

type FileEntry = { path: string; basename: string; extension: string; mtime: number };

// ── Build mock vault + app backed by the test server ─────────────────────────
// frontmatterByPath must be pre-fetched in beforeAll — getFileCache is called
// synchronously by enrichFile() so it cannot make async server calls at call time.
// backlinksByPath is optional; when provided it enables real recency scoring.
function buildMockEnv(
    fileEntries: FileEntry[],
    frontmatterByPath: Map<string, Record<string, unknown> | null>,
    backlinksByPath?: Map<string, [string, unknown[]][]>,
) {
    const fileMap = new Map(
        fileEntries.map((e) => {
            const f = new (TFile as any)(e.path) as TFile;
            f.stat.mtime = e.mtime;
            return [e.path, f];
        }),
    );

    const vault = {
        getFileByPath: (path: string) => {
            const found = fileMap.get(path);
            if (found) return found;
            // Fallback for files not pre-loaded (e.g. some backlink sources)
            const fallback = new (TFile as any)(path) as TFile;
            fallback.stat.mtime = 0; // Very old
            return fallback;
        },
        cachedRead: (file: TFile) => serverGetText("/file", { path: file.path }),
        read: (file: TFile) => serverGetText("/file", { path: file.path }),
        create: async (_path: string, _content: string) => {
            throw new Error("vault.create not supported in tests");
        },
    };

    const metadataCache = {
        // Synchronous — mirrors the real Obsidian API; data pre-fetched in beforeAll
        getFileCache: (file: TFile) => {
            const fm = frontmatterByPath.get(file.path);
            return fm ? { frontmatter: fm } : null;
        },
        getBacklinksForFile: (file: TFile) => ({
            data: new Map<string, unknown[]>(backlinksByPath?.get(file.path) ?? []),
        }),
    };

    const fileManager = {
        // Don't write to the real vault during tests
        processFrontMatter: async (_file: TFile, _fn: (fm: Record<string, unknown>) => void) => {},
    };

    return { vault, app: { metadataCache, fileManager, vault }, fileMap };
}

// ── Plugin dir / settings ─────────────────────────────────────────────────────
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_DIR = resolve(PLUGIN_DIR, "tests/scratch");

const settings: TranscriptionSettings = {
    ...DEFAULT_SETTINGS,
    openaiKey: (() => {
        const p = resolve(PLUGIN_DIR, "data.json");
        return existsSync(p)
            ? (JSON.parse(readFileSync(p, "utf8")).openaiKey ?? "")
            : (process.env.OPENAI_API_KEY ?? "");
    })(),
    lastModifiedFrontmatterField: (() => {
        const p = resolve(PLUGIN_DIR, "data.json");
        return existsSync(p)
            ? (JSON.parse(readFileSync(p, "utf8")).lastModifiedFrontmatterField ?? "date_modified")
            : "date_modified";
    })(),
};

// ── Test suite ────────────────────────────────────────────────────────────────
describe("AutoWikilinkEngine", () => {
    let engine: AutoWikilinkEngine;
    let personEntityType: EntityTypeConfig;

    beforeAll(async () => {
        // Verify test server is reachable
        await serverGet("/health").catch(() => {
            throw new Error(
                "Test server not reachable at " + TEST_SERVER + ". " +
                "Set testMode: true in data.json and rebuild the plugin.",
            );
        });

        console.log("Test server reachable. Loading vault files...");

        const fileEntries = await serverGet<FileEntry[]>("/files", { glob: "Tags/People/*" });

        // Pre-fetch frontmatter for all files — getFileCache must be synchronous
        const frontmatterByPath = new Map<string, Record<string, unknown> | null>();
        await Promise.all(
            fileEntries.map(async (e) => {
                const fm = await serverGet<Record<string, unknown> | null>("/frontmatter", { path: e.path });
                frontmatterByPath.set(e.path, fm);
            }),
        );

        const { vault, app, fileMap } = buildMockEnv(fileEntries, frontmatterByPath);

        personEntityType = {
            type: "person",
            matchStrategy: "phonetic",
            files: fileEntries.map((e) => fileMap.get(e.path)!).filter(Boolean),
        };

        engine = new AutoWikilinkEngine(settings, vault as any, null, app as any);
        console.log(`Loaded ${fileEntries.length} people files from vault.`);
    });

    it("links known people in a synthetic journal snippet", async () => {
        const input = [
            "### Work Session",
            "",
            "Today I worked on some projects and had a call with Alice.",
            "",
            "I met up with Bob around 6 pm and we worked on the project together.",
            "",
            "### Evening Plans",
            "",
            "Carol stopped by later in the evening.",
        ].join("\n");

        const result = await engine.applyAutoWikilink(input, [personEntityType]);

        console.log("Result:\n", result);

        expect(result).toMatch(/\[\[.*Alice.*\]\]/);
        expect(result).toMatch(/\[\[.*Carol.*\]\]/);
        expect(result).toContain("Bob");
    });
});

// ── Real recording wikilink tests (with real backlinks for accurate recency scoring) ──

const REAL_RECORDING_BASENAMES = [
    "recording-name-1",
    "recording-name-2",
];

describe("AutoWikilinkEngine — real recordings (with backlinks)", () => {
    let engine: AutoWikilinkEngine;
    let personEntityType: EntityTypeConfig;

    beforeAll(async () => {
        await serverGet("/health").catch(() => {
            throw new Error(
                "Test server not reachable at " + TEST_SERVER + ". " +
                "Set testMode: true in data.json and rebuild the plugin.",
            );
        });

        const peopleEntries = await serverGet<FileEntry[]>("/files", { glob: "Tags/People/*" });
        // Journal files are backlink sources — the engine looks them up to get their mtime.
        // Include them in the mock vault so getFileOrThrow doesn't throw.
        const journalEntries = await serverGet<FileEntry[]>("/files", { glob: "Journal/**" });
        const allEntries = [...peopleEntries, ...journalEntries];
        console.log(`Loaded ${peopleEntries.length} people files, ${journalEntries.length} journal files.`);

        // Pre-fetch frontmatter for people files (synchronous getFileCache requires this)
        const frontmatterByPath = new Map<string, Record<string, unknown> | null>();
        await Promise.all(
            peopleEntries.map(async (e) => {
                const fm = await serverGet<Record<string, unknown> | null>("/frontmatter", { path: e.path });
                frontmatterByPath.set(e.path, fm);
            }),
        );

        // Pre-fetch real backlinks for people files (needed for accurate recency/popularity scoring)
        const backlinksByPath = new Map<string, [string, unknown[]][]>();
        for (const e of peopleEntries) {
            const bl = await serverGet<[string, unknown[]][]>("/backlinks", { path: e.path });
            backlinksByPath.set(e.path, bl);
            await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay
        }

        const { vault, app, fileMap } = buildMockEnv(allEntries, frontmatterByPath, backlinksByPath);

        personEntityType = {
            type: "person",
            matchStrategy: "phonetic",
            files: peopleEntries.map((e) => fileMap.get(e.path)!).filter(Boolean),
        };

        engine = new AutoWikilinkEngine(settings, vault as any, null, app as any);
    });

    for (const basename of REAL_RECORDING_BASENAMES) {
        it(`wikilink step: ${basename}`, async () => {
            const scratchDir = resolve(SCRATCH_DIR, basename);
            const p3 = resolve(scratchDir, "03-headers.txt");
            if (!existsSync(p3)) {
                console.warn(`Skipping: ${p3} not found. Run pipelineEngine tests first.`);
                return;
            }

            const input = readFileSync(p3, "utf8");
            console.log(`\n══ ${basename} — wikilink step ══════════════════════════════`);

            const result = await engine.applyAutoWikilink(input, [personEntityType]);

            mkdirSync(scratchDir, { recursive: true });
            writeFileSync(resolve(scratchDir, "04-wikilinks.txt"), result, "utf8");

            console.log("\n── Wikilink output ──\n" + result);
        }, 5 * 60 * 1000);
    }
});
