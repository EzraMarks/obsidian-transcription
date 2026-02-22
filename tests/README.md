# Tests

## Structure

```
tests/
  __mocks__/obsidian.ts        Obsidian module stub (requestUrl → fetch, class stubs)
  scratch/                     Local test data — gitignored, never committed
  autoWikilinkEngine.test.ts   Vitest integration test
  README.md                    This file

scripts/
  iterate-cleanup.mjs          Interactively iterate on the journal_cleanup prompt
  iterate-header-prompt.mjs    Interactively iterate on the journal_headers prompt
  iterate-wikilink.mjs         Interactively iterate on entity tagging/resolution
```

---

## Two kinds of testing

### Automated tests (`npm test`)

Runs the Vitest test suite. These import the real TypeScript engine code and make live
OpenAI API calls — they are integration tests, not unit tests.

### Interactive iteration scripts (`scripts/iterate-*.mjs`)

Run manually to inspect and refine a specific pipeline step against a real journal
entry. Not part of `npm test`. Run any script with `--help` for usage.

---

## Prerequisites for `npm test`

### 1. OpenAI API key

Must be present in `data.json` at the plugin root:

```json
{ "openaiKey": "sk-..." }
```

### 2. The plugin test server

The tests need access to real Obsidian internals (vault files, frontmatter, backlinks)
that aren't available in Node.js. The plugin includes a small HTTP server that exposes
these when `testMode` is enabled in `data.json`.

**To enable:**

1. Set `testMode: true` in `data.json`:
   ```json
   { "openaiKey": "sk-...", "testMode": true }
   ```
2. Rebuild the plugin so Obsidian reloads it (`npm run dev`, or trigger a rebuild).
   The server starts automatically on port `27125`.
3. Run `npm test`.

**To disable:** set `testMode: false` and rebuild.

The `testMode` flag is not exposed in the plugin settings UI — it is only meant to be
set manually or by tooling. `data.json` is gitignored so it will never be committed.

---

## Scratch data

`tests/scratch/` is a gitignored local folder for test data. Nothing in it is ever
committed.

### Populating scratch data

To test pipeline stages against a real audio recording, point Claude at an audio file
in your vault and ask it to run the pipeline and save intermediate outputs to
`tests/scratch/`. Claude will run each stage through the real plugin code and save:

| File | Pipeline stage |
|---|---|
| `tests/scratch/01-raw-transcript.txt` | Output of `audio_transcription` |
| `tests/scratch/02-cleanup.txt` | Output of `journal_cleanup` |
| `tests/scratch/03-headers.txt` | Output of `add_headers` |
| `tests/scratch/04-wikilinks.txt` | Output of `auto_wikilink` |

You only need to do this when you want to refresh the test data. The saved outputs
can be reused across many test runs without re-running the pipeline.
