/** How confident the AI is in its file selection for an entity. */
export enum SelectionConfidence {
    /** No matching file was found — the entity may be new or too ambiguous to resolve. */
    Unmatched = "unmatched",
    /** The AI picked from multiple surviving candidates — a judgment call that may be wrong. */
    Uncertain = "uncertain",
    /** A single candidate survived all filtering — the AI is reasonably confident in this match. */
    Likely = "likely",
    /** The AI is highly confident — strong recent context and clear alignment with the candidate. */
    Certain = "certain",
}
