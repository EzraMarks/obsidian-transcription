Help the user iterate on the `journal_headers` system prompt in `referenceConfiguration/journalTranscription.yaml`.

## What this workflow does

`scripts/test-header-prompt.mjs` strips the existing `###`/`####` section headers from a journal entry (one `##`-delimited day in a weekly journal file), then calls the OpenAI API with the current `add_headers` system prompt to regenerate headers. This lets us see what the prompt produces and refine it without re-transcribing audio.

## Cost awareness — IMPORTANT

Every run of this script makes a real OpenAI API call that costs money. Before running:
- **Always confirm** which file and which specific entry (day) to test before executing.
- **Never use `--all`** without explicitly asking the user first and warning them it will make one API call per entry.
- **Default to testing one entry at a time.** Suggest picking a representative day rather than running multiple.
- If the user wants to compare prompts, edit the YAML and re-run on the same single entry — don't run on many entries at once.

## How to run

```bash
# List available entries in a file (no API call)
node scripts/test-header-prompt.mjs "Journal/2026-W08.md"

# Run on a specific entry (one API call)
node scripts/test-header-prompt.mjs --entry 2 "Journal/2026-W08.md"

# See stripped paragraph-numbered input without calling the API
node scripts/test-header-prompt.mjs --strip-only --entry 2 "Journal/2026-W08.md"
```

Journal files are in the Obsidian vault at `../../../Journal/` relative to the plugin dir (i.e. the vault root is three levels up from the plugin). Recent weekly files are named like `2026-W08.md`.

## Iteration workflow

1. Run on a chosen entry to see current output.
2. Discuss with the user what they like or don't like about the headers produced.
3. Edit `system_prompt` under the `journal_headers` step in `referenceConfiguration/journalTranscription.yaml`.
4. Re-run on the **same entry** to compare. Repeat.
5. Once happy, the updated YAML is the source of truth — it gets deployed when the plugin is used in Obsidian.
