import { App, TFile, Vault } from "obsidian";
import { TranscriptionSettings } from "./settings";

export class UtilsEngine {
    constructor(readonly settings: TranscriptionSettings, readonly vault: Vault, readonly app: App) {}

    /**
     * For a given sourcePath, returns the timestamp (ms since epoch)
     * of `date_modified` frontmatter if present, otherwise file.stat.mtime.
     */
    getSourceFileTime(sourcePath: string): number {
        const sourceFile = this.getFileOrThrow(sourcePath);
        const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
        const dateModified = frontmatter?.["date_modified"];
        const mtime = dateModified ? new Date(dateModified).getTime() : sourceFile.stat.mtime;

        return mtime;
    }

    getFileOrThrow(sourcePath: string): TFile {
      const sourceFile = this.vault.getFileByPath(sourcePath);
      if (!sourceFile) throw new Error(`Source file not found for path: ${sourcePath}`);
      return sourceFile;
    }
}
