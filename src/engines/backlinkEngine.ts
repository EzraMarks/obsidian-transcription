import { App, LinkCache, TFile, Vault } from "obsidian";
import { TranscriptionSettings } from "src/settings";
import { UtilsEngine } from "./utilsEngine";
import { biasedSample } from "src/utils";

/** EXPOSING INTERNAL OBSIDIAN TYPES https://forum.obsidian.md/t/get-backlinks-of-a-file/81638/2 */
export type BacklinksArrayDict = [sourcePath: string, references: LinkCache[]][];

export interface BacklinkEntry {
    sourcePath: string;
    reference: LinkCache;
}

export class BacklinkEngine {
    constructor(
        private readonly settings: TranscriptionSettings,
        private readonly vault: Vault,
        private readonly app: App,
        private readonly utilsEngine: UtilsEngine,
    ) {}

    /** Calculates the total number of backlinks */
    calculateBacklinkCount(backlinks: BacklinksArrayDict): number {
        return backlinks.reduce((acc, [_, refs]) => acc + refs.length, 0);
    }

    /* Calculates the age in days since the most recent edit on any file that links to this file; proxy for the last time this file was referenced */
    calculateDaysSinceLastBacklinkEdit(backlinks: BacklinksArrayDict): number {
        let mostRecentMention = 0;

        backlinks.forEach(([sourcePath, _]) => {
            const mtime = this.utilsEngine.getSourceFileTime(sourcePath);
            mostRecentMention = Math.max(mostRecentMention, mtime);
        });

        if (mostRecentMention === 0) return Infinity; // No backlinks, return a large value
        return (Date.now() - mostRecentMention) / 1000 / 60 / 60 / 24; // Age in days
    }

    getBacklinksForFile(file: TFile): BacklinksArrayDict {
        // A map-like object that maps a source path to an array of backlinks
        // https://forum.obsidian.md/t/how-to-get-backlinks-for-a-file/45314
        const allBacklinks = (this.app.metadataCache as any).getBacklinksForFile(file).data;

        return [...allBacklinks.entries()];

        //     if ('position' in backlink) {
        //         return backlink as ReferenceCache
        //         // This is a ReferenceCache
        //     } else { // or equivalently: if ('key' in backlink)
        //         // This is a FrontmatterLinkCache
        //         return backlink as FrontmatterLinkCache
        //     }
    }

    /**
     * Return up to `sampleSize` backlink entries
     * from a BacklinksArrayDict, prioritizing the most recent.
     */
    getRandomRecentBacklinkEntries(backlinks: BacklinksArrayDict, sampleSize: number): BacklinkEntry[] {
        const sortedBacklinks = this.sortBacklinksByRecency(backlinks).slice(0, Math.min(sampleSize, backlinks.length));

        const sortedBacklinkEntries: BacklinkEntry[] = sortedBacklinks.flatMap(([sourcePath, references]) =>
            references.map((reference) => ({ sourcePath, reference })),
        );

        if (sortedBacklinkEntries.length <= sampleSize) return sortedBacklinkEntries;

        return biasedSample(sortedBacklinkEntries, sampleSize);
    }

    /**
     * Return a new BacklinksArrayDict sorted descending by the most-recent
     * edit time of each source file (frontmatter `date_modified` or `mtime`).
     */
    private sortBacklinksByRecency(backlinks: BacklinksArrayDict): BacklinksArrayDict {
        return [...backlinks].sort(([pathA], [pathB]) => {
            const timeA = this.utilsEngine.getSourceFileTime(pathA);
            const timeB = this.utilsEngine.getSourceFileTime(pathB);
            return timeB - timeA;
        });
    }
}
