/* Utility functions for Obsidian Transcript */
import { doubleMetaphone } from "double-metaphone";
import { App, FileSystemAdapter } from "obsidian";
import { soundex } from "soundex-code";

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
 * @author this function was primarily AI-generated
 *
 * Extracts the sentence containing the given column index from the line.
 * If the sentence is unusually short, includes a few words of context on either side.
 * Adds ellipses if the snippet doesn't start or end at the line boundaries.
 */
export function extractSentence(line: string, col: number, contextWords = 14): string {
    // Standard sentence boundary: . ! ? possibly followed by quotes/brackets and whitespace
    const sentenceRegex = /[^.!?]*[.!?]+["')\]]*\s*|[^.!?]+$/g;
    let match: RegExpExecArray | null;
    let sentenceStart = 0;
    let sentenceEnd = line.length;

    // Find the sentence containing the col position
    while ((match = sentenceRegex.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (col >= start && col < end) {
            sentenceStart = start;
            sentenceEnd = end;
            break;
        }
    }

    // Fallback to whole line if not found
    const snippet = line.slice(sentenceStart, sentenceEnd).trim();

    // If the sentence is long enough, just return it (with ellipses if needed)
    const wordCount = snippet.split(/\s+/).length;
    if (wordCount >= contextWords || (sentenceStart === 0 && sentenceEnd === line.length)) {
        const prefix = sentenceStart > 0 ? "…" : "";
        const suffix = sentenceEnd < line.length ? "…" : "";
        return `${prefix}${snippet}${suffix}`;
    }

    // Otherwise, expand contextWords on either side (by word)
    const words = line.split(/\s+/);
    // Find the word index that includes the col position
    let charCount = 0;
    let targetWordIndex = 0;
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

    const startWord = Math.max(0, targetWordIndex - Math.floor(contextWords / 2));
    const endWord = Math.min(words.length, targetWordIndex + Math.ceil(contextWords / 2) + 1);
    const expanded = words.slice(startWord, endWord).join(" ");
    const prefix = startWord > 0 ? "…" : "";
    const suffix = endWord < words.length ? "…" : "";
    return `${prefix}${expanded}${suffix}`;
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

export interface PhoneticEncoding {
    displayName: string; // E.g. "Aiden"
    soundexEncoding: string; // E.g. "A450"
    metaphoneEncodings: string[]; // E.g. ["AIDN", "EADN"]
}

export interface PhoneticMatch {
    // The encoding that was matched
    candidateEncoding: PhoneticEncoding;
    // The encoding that was being matched against
    targetEncoding: PhoneticEncoding;
    // The levenshtein distance between the candidate and target phonetic encodings
    phoneticDistance: number;
    // The levenshtein distance between the candidate and target display names
    displayNameDistance: number;
}

export function getPhoneticEncoding(name: string): PhoneticEncoding {
    const soundExEncoding = soundex(name);
    const metaphoneEncodings = doubleMetaphone(name);

    return {
        displayName: name,
        soundexEncoding: soundExEncoding,
        metaphoneEncodings: metaphoneEncodings,
    };
}

export function toArray<T>(value: T | T[] | undefined): T[] {
    if (Array.isArray(value)) return value;
    if (value != undefined) return [value];
    return [];
}
