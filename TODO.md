# Obsidian Transcription — Backlog

## Entity Resolution

### Phonetic matching only works for names
Soundex/Double Metaphone is designed for English names. For books, TV shows, and especially
projects (which may be referred to by abbreviations or totally different nicknames), a different
candidate-retrieval strategy is needed. For entity types with small corpus (projects, current
media), load all files directly rather than relying on phonetic pre-filtering.

### Cached entity summaries for richer candidate matching
Currently `selectFromFinalCandidates` feeds raw sample sentences from previous mentions into the
LLM. A better approach: use a small model to generate a cached summary of who/what each entity
appears to be, based on all their backlinked mentions. This summary would be stored in a hidden
cache file and used in place of (or alongside) raw sample occurrences.

Cache invalidation: regenerate a summary when the file's modified date or backlink count has
changed significantly since the summary was last generated. Summary generation is a one-time
cost per entity file rather than per transcription run, and gives the selection LLM a more
information-dense signal than disconnected raw sentences.
