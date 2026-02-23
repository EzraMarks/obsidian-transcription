# obsidian-transcription

Obsidian plugin that transcribes audio files and post-processes them through a configurable YAML pipeline (transcription → cleanup → headers → wikilinks).

## Key files

- `referenceConfiguration/journalTranscription.yaml` — the reference pipeline config. This is the canonical source of truth for the journal transcription pipeline steps and prompts.
- `src/pipelineEngine.ts` — executes pipeline steps; contains the `add_headers` and `auto_wikilink` logic.
- `src/engines/utilsEngine.ts` — OpenAI API helpers (`callOpenAI`, `callOpenAIStructured`).

## Iterating on the header prompt

Use `/iterate-header-prompt` to work on the `journal_headers` system prompt. See `.claude/commands/iterate-header-prompt.md` for full details.

**Cost warning:** every script run makes a real OpenAI API call. Always confirm with the user before running, and default to one entry at a time.

## Vault location

The Obsidian vault root is at `../../..` relative to this plugin directory. Journal files are weekly markdown files at `Journal/YYYY-Www.md`, each containing multiple `##`-headed day entries.
