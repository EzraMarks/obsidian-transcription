/* Utility functions for Obsidian Transcript */
import { App, FileSystemAdapter } from "obsidian";

export const randomString = (length: number) =>
    Array(length + 1)
        .join((Math.random().toString(36) + "00000000000000000").slice(2, 18))
        .slice(0, length);
export const getAllLinesFromFile = (cache: string) => cache.split(/\r?\n/);
export const combineFileLines = (lines: string[]) => lines.join("\n");

export function getVaultAbsolutePath(app: App) {
    // Original code was copied 2021-08-22 from https://github.com/phibr0/obsidian-open-with/blob/84f0e25ba8e8355ff83b22f4050adde4cc6763ea/main.ts#L66-L67
    // But the code has been rewritten 2021-08-27 as per https://github.com/obsidianmd/obsidian-releases/pull/433#issuecomment-906087095
    const adapter = app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
        return adapter.getBasePath();
    }
    return null;
}

/**
 * Selects a sample of items from a list sorted newest to oldest, with a tunable bias toward the newest items.
 *
 * Uses exponential bias to favor items at the start of the list (the newest ones), while still
 * occasionally selecting older items. The `biasStrength` parameter controls how sharply the bias skews:
 *
 *   - biasStrength = 1 → uniform distribution (no bias)
 *   - biasStrength = 2 → quadratic bias: ~75% of samples will come from the newest half
 *   - biasStrength = 3 → cubic bias: ~87.5% from the newest half
 *   - biasStrength = 4 → quartic bias: ~93.75% from the newest half
 *
 * Higher values of `biasStrength` concentrate selection more strongly toward the newest items.
 *
 * @param list - A sorted array of items (newest to oldest).
 * @param sampleSize - The number of items to sample.
 * @param biasStrength - Controls how strongly newer items are favored (default: 2).
 * @returns A biased sample of items from the input list.
 */
export function biasedSample<T>(list: T[], sampleSize: number, biasStrength = 2): T[] {
    const result: T[] = [];
    const usedIndices = new Set<number>();

    while (result.length < sampleSize && usedIndices.size < list.length) {
        const r = Math.random();
        const biased = Math.pow(r, biasStrength); // Biases toward 0 (front of list = newest)
        const index = Math.floor(biased * list.length);

        if (!usedIndices.has(index)) {
            result.push(list[index]);
            usedIndices.add(index);
        }
    }

    return result;
}

/**
 * Pulls out a sentence-length snippet around the given column index.
 * Adds ellipses if the snippet doesn't start or end at the line boundaries.
 */
export function extractSentence(line: string, col: number, contextWords = 14): string {
    const words = line.split(/\s+/);
    let charCount = 0;
    let targetWordIndex = 0;

    // Find the word index that includes the col position
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const start = charCount;
        const end = start + word.length;
        if (col >= start && col < end) {
            targetWordIndex = i;
            break;
        }
        charCount = end + 1; // +1 for the space
    }

    const start = Math.max(0, targetWordIndex - contextWords);
    const end = Math.min(words.length, targetWordIndex + contextWords + 1);
    const snippet = words.slice(start, end).join(" ");

    const prefix = start > 0 ? "…" : "";
    const suffix = end < words.length ? "…" : "";
    return `${prefix}${snippet}${suffix}`;
}

/** Walks backward from `lineNum` looking for the closest Markdown heading (## or ###) */
export function findNearestHeading(lines: string[], lineNum: number): string | undefined {
    for (let i = lineNum; i >= 0; i--) {
        const match = lines[i].match(/^(##+)\s+(.*)$/);
        if (match) {
            return match[2].trim();
        }
    }
    return undefined;
}
