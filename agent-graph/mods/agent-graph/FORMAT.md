# Agent graph history format

The recorder (`recorder.py`) writes it; the mod (`main.js`) reads it. Neither changes it alone.

File: `~/.local/share/herdr-agent-graph/history.json`, replaced atomically (write a temp file
named `history.json.<pid>.tmp` in the same folder, then rename). One recorder at a time holds an
exclusive `fcntl.flock` on `history.lock` in that folder. The serialized file is always under
900,000 bytes, so `readTextFile` (1 MiB limit) can read it. A file that can't be read, or isn't a
version 1 history, is kept aside as `history.json.bad-<epoch>` before the recorder starts empty,
so a bad read never destroys it.

```json
{
  "version": 1,
  "updated_ms": 1793420740665,
  "records": [
    {
      "id": "t26@1793419700000",
      "address": "t26",
      "parent": "t19",
      "parent_id": "t19@1793419600000",
      "name": "abc290-rev-sol",
      "agent": "codex",
      "command": "codex -m gpt-6.1-sol -c model_reasoning_effort=high --approve-for-me Revi…",
      "cwd": "/Users/me/...",
      "where": "example-app / review",
      "state": "live",
      "status": "working",
      "created_ms": 1793419700000,
      "finished_ms": null,
      "exit_code": null,
      "reason": null,
      "removed_ms": null
    }
  ]
}
```

- `id` is `<address>@<created_ms>`. Addresses can be reused after `hc rm`; ids never are.
- `address` is as hc prints it: `t7` here, `machine/t7` on another machine. `parent` is the
  raw parent address, qualified with the child's machine prefix when the child has one and the
  parent doesn't; null when the terminal has none.
- `parent_id` is the id of a retained record with address `parent` and the latest `created_ms`
  not after the child's `created_ms`; null when no retained record qualifies (the parent was
  removed before the recorder saw it, or was pruned). Then `parent` still says who it was.
- `agent` is `hc ls`'s `agent` word (`claude-code`, `codex`, `grok`, `zsh`, ...) or null.
- `state`: `live` | `finished`. `status`: one word (`working`, `blocked`, `idle`, `done`,
  `error`, or another word hc reports) or null for plain programs. Never an object.
- `reason` (when finished): `exited` | `killed` | as hc reports; `exit_code` may be null.
  `removed_ms`: when the recorder saw the terminal disappear (`hc rm`, or gone from its connected
  machine's listing); null while it exists, and also null when the recorder never saw it go (so a
  null `removed_ms` does not prove the terminal still exists).
- A sub-agent a terminal reports (an OSC 7501 record other than the program's root one, kept by
  hc in the terminal's `records` by id, as Claude Code does for each running Agent-tool
  sub-agent) is a record too. Its `address` is `<terminal address>#<record id>`, the id
  percent-encoded the way JavaScript's `encodeURIComponent` does it (`t7#a1`, `machine/t7#a1`);
  `parent` is the terminal's address; `name` is the record's title; `status` its state; `agent`,
  `cwd` and `where` are the terminal's; `command` is null. `created_ms` is when the recorder first
  saw the record. When the terminal stops reporting it, finishes or is removed, the record becomes
  `finished` with that time as `finished_ms`; `exit_code`, `reason` and `removed_ms` stay null,
  since the program doesn't say how a sub-agent ended.
- Text limits (characters, longer values cut and ended with `…`): `command` 200 (argv joined with
  spaces), `cwd` 300, `name` 120, `where` 160.
- Times are Unix milliseconds. Records are sorted by `created_ms` ascending.
- Kept: every record still in the core, plus removed or finished ones whose latest timestamp is
  within 14 days. Non-current records are capped at 1500 in total; current records are exempt from
  that count. If the file would still reach 900,000 bytes, the oldest non-current records are
  dropped first; if only current records remain and it is still too large, the oldest of those are
  dropped too, so the serialized file always fits the reader's 1 MiB limit.
