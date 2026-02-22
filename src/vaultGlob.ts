import { TFile, TFolder, Vault } from "obsidian";
import { minimatch } from "minimatch";

/**
 * Efficiently find all TFile in your vault matching a single glob
 * by only descending the sub-tree under its static prefix.
 *
 * @param extensions - Optional allowlist of file extensions (e.g. ["md"], ["m4a", "mp3"]).
 *                     If omitted, files of any extension are returned.
 */
export function getFilesFromGlob(vault: Vault, pattern: string, extensions?: string[]): TFile[] {
    const prefix = getStaticPrefix(pattern);
    const start = vault.getAbstractFileByPath(prefix) as TFolder;
    const root = start instanceof TFolder ? start : vault.getRoot();

    const matches: TFile[] = [];
    const walk = (fld: TFolder) => {
        for (const child of fld.children) {
            if (child instanceof TFolder) {
                walk(child);
            } else if (child instanceof TFile && minimatch(child.path, pattern)) {
                if (!extensions || extensions.includes(child.extension)) {
                    matches.push(child);
                }
            }
        }
    };
    walk(root);
    return matches;
}

/**
 * Extract the longest path prefix up to (but not including)
 * the first glob character (*, ?, or [).
 */
function getStaticPrefix(pattern: string): string {
    const idx = pattern.search(/[*?\[]/);
    if (idx === -1) return pattern;
    const cut = pattern.slice(0, idx);
    const slash = cut.lastIndexOf("/");
    return slash >= 0 ? cut.slice(0, slash) : "";
}
