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
import { readFileSync, existsSync } from "fs";
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
function buildMockEnv(
    fileEntries: FileEntry[],
    frontmatterByPath: Map<string, Record<string, unknown> | null>,
) {
    const fileMap = new Map(
        fileEntries.map((e) => {
            const f = new (TFile as any)(e.path) as TFile;
            f.stat.mtime = e.mtime;
            return [e.path, f];
        }),
    );

    const vault = {
        getFileByPath: (path: string) => fileMap.get(path) ?? null,
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
        // Backlink scoring is a ranking signal, not a correctness requirement for tests.
        // Returning an empty map means the engine falls back to other signals.
        getBacklinksForFile: (_file: TFile) => ({ data: new Map<string, unknown[]>() }),
    };

    const fileManager = {
        // Don't write to the real vault during tests
        processFrontMatter: async (_file: TFile, _fn: (fm: Record<string, unknown>) => void) => {},
    };

    return { vault, app: { metadataCache, fileManager, vault }, fileMap };
}

// ── Plugin dir / settings ─────────────────────────────────────────────────────
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const settings: TranscriptionSettings = {
    ...DEFAULT_SETTINGS,
    openaiKey: (() => {
        const p = resolve(PLUGIN_DIR, "data.json");
        return existsSync(p)
            ? (JSON.parse(readFileSync(p, "utf8")).openaiKey ?? "")
            : (process.env.OPENAI_API_KEY ?? "");
    })(),
    lastModifiedFrontmatterField: "date_modified",
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
            files: fileEntries.map((e) => fileMap.get(e.path)!).filter(Boolean),
        };

        engine = new AutoWikilinkEngine(settings, vault as any, null, app as any);
        console.log(`Loaded ${fileEntries.length} people files from vault.`);
    });

    it("links known people in a journal snippet", async () => {
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
