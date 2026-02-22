/**
 * Integration test for AutoWikilinkEngine.
 *
 * - Imports the real TypeScript engine code
 * - obsidian is mocked via __mocks__/obsidian.ts (requestUrl → fetch)
 * - ResolveEntityModal is mocked to auto-accept AI selections
 * - Vault files + frontmatter are loaded from the Obsidian Local REST API
 * - OpenAI calls go through normally (real API key from data.json)
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "yaml";
import { TFile } from "obsidian";
import { AutoWikilinkEngine } from "src/engines/autoWikilinkEngine";
import type { EntityTypeConfig } from "src/engines/autoWikilinkEngine";
import { DEFAULT_SETTINGS } from "src/settings";
import type { TranscriptionSettings } from "src/settings";

// ── Mock: auto-accept the resolve-entity modal ─────────────────────────────
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
            // Immediately resolve with the AI-chosen selections, no UI needed
            this.onComplete(this.selections);
        }
    },
}));

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname_test = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname_test, "..");

// ── Obsidian Local REST API ───────────────────────────────────────────────────
const REST_API_DATA_PATH = resolve(PLUGIN_DIR, "../obsidian-local-rest-api/data.json");
const REST_API_DATA = JSON.parse(readFileSync(REST_API_DATA_PATH, "utf8"));
const OBSIDIAN_BASE = "http://127.0.0.1:27123";
const OBSIDIAN_KEY = REST_API_DATA.apiKey as string;

async function vaultGetText(vaultPath: string): Promise<string> {
    const url = `${OBSIDIAN_BASE}/vault/${encodeURIComponent(vaultPath)}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${OBSIDIAN_KEY}`, Accept: "text/markdown" },
    });
    if (!res.ok) throw new Error(`REST ${res.status}: ${vaultPath}`);
    return res.text();
}

async function walkVaultFolder(folderPath: string): Promise<string[]> {
    const folder = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    const url = `${OBSIDIAN_BASE}/vault/${encodeURIComponent(folder)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${OBSIDIAN_KEY}` } });
    if (!res.ok) return [];
    const data = (await res.json()) as { files: string[] };
    const all: string[] = [];
    for (const item of data.files) {
        if (item.endsWith("/")) {
            all.push(...(await walkVaultFolder(folder + item.slice(0, -1))));
        } else if (item.endsWith(".md")) {
            all.push(folder + item);
        }
    }
    return all;
}

function parseFrontmatter(text: string): Record<string, unknown> | null {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    try {
        return yaml.parse(match[1]) as Record<string, unknown>;
    } catch {
        return null;
    }
}

// ── Build mock vault + app ────────────────────────────────────────────────────
function buildMockEnv(filePaths: string[], frontmatterByPath: Map<string, Record<string, unknown>>) {
    const fileMap = new Map(filePaths.map((p) => [p, new TFile(p)]));

    // Apply date_modified from frontmatter to stat.mtime if present
    for (const [path, file] of fileMap) {
        const fm = frontmatterByPath.get(path);
        const d = fm?.date_modified as string | undefined;
        if (d) {
            const t = new Date(d).getTime();
            if (!isNaN(t)) file.stat.mtime = t;
        }
    }

    const vault = {
        getFileByPath: (path: string) => fileMap.get(path) ?? null,
        read: (file: TFile) => vaultGetText(file.path),
        cachedRead: (file: TFile) => vaultGetText(file.path),
        create: async (_path: string, _content: string) => { throw new Error("vault.create not supported in tests"); },
    };

    const metadataCache = {
        getFileCache: (file: TFile) => {
            const fm = frontmatterByPath.get(file.path);
            return fm ? { frontmatter: fm } : null;
        },
        getBacklinksForFile: (_file: TFile) => ({ data: new Map<string, unknown[]>() }),
    };

    const fileManager = {
        // no-op: don't write to real vault during tests
        processFrontMatter: async (_file: TFile, _fn: (fm: Record<string, unknown>) => void) => {},
    };

    return {
        vault,
        app: { metadataCache, fileManager, vault },
        fileMap,
    };
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("AutoWikilinkEngine", () => {
    let engine: AutoWikilinkEngine;
    let personEntityType: EntityTypeConfig;

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

    beforeAll(async () => {
        console.log("Fetching vault files from Local REST API...");

        const peoplePaths = await walkVaultFolder("Tags/People");
        const frontmatterByPath = new Map<string, Record<string, unknown>>();

        // Load frontmatter for all people files (needed for alias/misspelling enrichment)
        await Promise.all(
            peoplePaths.map(async (path) => {
                try {
                    const text = await vaultGetText(path);
                    const fm = parseFrontmatter(text);
                    if (fm) frontmatterByPath.set(path, fm);
                } catch {
                    /* skip unreadable files */
                }
            }),
        );

        const { vault, app, fileMap } = buildMockEnv(peoplePaths, frontmatterByPath);

        personEntityType = {
            type: "person",
            files: peoplePaths.map((p) => fileMap.get(p)!).filter(Boolean),
        };

        engine = new AutoWikilinkEngine(settings, vault as any, null, app as any);
        console.log(`Loaded ${peoplePaths.length} people files.`);
    });

    it("links known people in a journal snippet", async () => {
        // Short snippet with three known people — mirrors W15 Tuesday entry
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

        // Unambiguous people should get linked
        expect(result).toMatch(/\[\[.*Alice.*\]\]/);
        expect(result).toMatch(/\[\[.*Carol.*\]\]/);
        // Non-linked names should remain as plain text (not broken)
        expect(result).toContain("Bob");
    });
});
