---
type: analysis-only
status: draft
slug: download-error-context
feature: sync
created: "2026-06-17"
---

# Impact Analysis: Add Filename Context to Download Error Log

## Goal

When `downloadFile()` fails (e.g. mobile filesystem rejects a filename), the error logged at `sync()` catch should include the offending filename — currently only `"FILE_NOTCREATED"` is logged, making diagnosis require manually correlating the error timestamp against the actions list in the same log run.

## Why Filename Is Lost Today

Call chain when `writeBinary` throws:

1. `vault.adapter.writeBinary(normalizedPath, ...)` — Obsidian mobile Capacitor adapter throws `new Error("FILE_NOTCREATED")`. **Message contains no filename** — this is Obsidian internals, not our code.
2. `downloadFile()` (`sync-manager.ts:1240`) — no try-catch. Raw error propagates.
3. Anonymous `async (action)` lambda in `Promise.all` (`sync-manager.ts:590-594`) — no per-file catch. Still raw `"FILE_NOTCREATED"`.
4. `sync()` catch (`sync-manager.ts:413`) — logs `err.message`. Gets `"FILE_NOTCREATED"` only — filename never added anywhere in chain.

## Impact Analysis

| Area | File / Location | Change Needed | Risk |
|---|---|---|---|
| `downloadFile()` | `sync-manager.ts:1240` | Add try-catch around `writeBinary`; re-throw `new Error(\`Failed to write \${normalizedPath}: \${originalErr.message}\`)` | **Low** — control flow unchanged; only error message content changes |
| `sync()` catch | `sync-manager.ts:413` | None — already logs `err.message`; picks up filename automatically once `downloadFile()` wraps it | **None** |
| `syncImpl()` `Promise.all` | `sync-manager.ts:587-601` | None — error propagation path unchanged | **None** |
| Tests (`sync-manager.test.ts`) | No tests cover `downloadFile`, `writeBinary`, or `FILE_NOTCREATED` | None needed | **None** — no test breakage |
| `firstSyncFromRemote()` `writeBinary` | `sync-manager.ts:268` | Same issue exists (bare `writeBinary`, no try-catch) — but outside this change's scope unless explicitly included | **Low** — same pattern, same fix if desired |

## Cross-Feature Risks

None. `downloadFile()` is called only from `syncImpl()` (`sync-manager.ts:591`) — single caller, no cross-module exposure. Logger interface unchanged.

## Edge Cases

- `normalizedPath` = empty string if `file.path` = `""` — `normalizePath("")` returns `""`. Error message would be `"Failed to write : FILE_NOTCREATED"`. Harmless but odd. Obsidian tree response never produces empty-path blobs in practice — `unclear — needs human input: confirm whether empty path is possible from GitHub tree API`.
- Re-thrown error loses original stack if wrapped in `new Error(message)` — use `cause` option (`new Error(msg, { cause: err })`) to preserve stack chain in environments that support it. Obsidian mobile may not surface `cause`, but desktop dev tools will.
- `mkdir` failure (line 1238) also throws without filename context — same pattern, same fix if desired. Out of scope for this change.

## Implementation Steps

N/A — analysis only.
