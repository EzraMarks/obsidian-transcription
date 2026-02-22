/**
 * Development-only test server.
 * Started when testMode is true in data.json. Exposes Obsidian internals
 * (vault files, frontmatter, backlinks) over HTTP so Vitest tests can access
 * the real plugin state without mocking these APIs.
 *
 * Endpoint summary:
 *   GET  /health                   — liveness check
 *   GET  /files?glob=<pattern>     — list vault files matching a glob
 *   GET  /file?path=<path>         — read file content
 *   GET  /frontmatter?path=<path>  — get parsed frontmatter
 *   GET  /backlinks?path=<path>    — get backlinks from the metadata cache
 *   POST /frontmatter?path=<path>  — merge JSON body into file frontmatter
 */

import * as http from "http";
import { App } from "obsidian";
import { getFilesFromGlob } from "./vaultGlob";

export const TEST_SERVER_PORT = 27125;

export class TestServer {
    private server: http.Server | null = null;

    constructor(private readonly app: App) {}

    start(): void {
        if (this.server) return;
        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
            });
        });
        this.server.listen(TEST_SERVER_PORT, "127.0.0.1", () => {
            console.log(
                `[obsidian-transcription] Test server listening on http://127.0.0.1:${TEST_SERVER_PORT}`,
            );
        });
    }

    stop(): void {
        if (!this.server) return;
        this.server.close();
        this.server = null;
        console.log("[obsidian-transcription] Test server stopped");
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${TEST_SERVER_PORT}`);
        const pathname = url.pathname;

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1");

        if (pathname === "/health") {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (pathname === "/files") {
            const glob = url.searchParams.get("glob") ?? "*";
            const files = getFilesFromGlob(this.app.vault, glob);
            res.writeHead(200);
            res.end(
                JSON.stringify(
                    files.map((f) => ({
                        path: f.path,
                        basename: f.basename,
                        extension: f.extension,
                        mtime: f.stat.mtime,
                    })),
                ),
            );
            return;
        }

        if (pathname === "/file") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing path param" }));
                return;
            }
            const file = this.app.vault.getFileByPath(filePath);
            if (!file) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "File not found" }));
                return;
            }
            const content = await this.app.vault.cachedRead(file);
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.writeHead(200);
            res.end(content);
            return;
        }

        if (pathname === "/frontmatter") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing path param" }));
                return;
            }
            const file = this.app.vault.getFileByPath(filePath);
            if (!file) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "File not found" }));
                return;
            }

            if (req.method === "GET") {
                const cache = this.app.metadataCache.getFileCache(file);
                res.writeHead(200);
                res.end(JSON.stringify(cache?.frontmatter ?? null));
                return;
            }

            if (req.method === "POST") {
                const body = await this.readBody(req);
                const updates = JSON.parse(body) as Record<string, unknown>;
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    Object.assign(fm, updates);
                });
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
                return;
            }
        }

        if (pathname === "/backlinks") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Missing path param" }));
                return;
            }
            const file = this.app.vault.getFileByPath(filePath);
            if (!file) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "File not found" }));
                return;
            }
            // BacklinkEngine uses (metadataCache as any).getBacklinksForFile(file).data
            // which is a Map<sourcePath, LinkCache[]>. Serialize as array of pairs.
            const raw = (this.app.metadataCache as any).getBacklinksForFile(file).data;
            const entries = [...(raw as Map<string, unknown[]>).entries()];
            res.writeHead(200);
            res.end(JSON.stringify(entries));
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: `Unknown route: ${pathname}` }));
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk.toString()));
            req.on("end", () => resolve(body));
            req.on("error", reject);
        });
    }
}
