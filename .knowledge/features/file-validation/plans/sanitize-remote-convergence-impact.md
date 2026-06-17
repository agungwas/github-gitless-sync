---
type: analysis-only
status: draft
slug: sanitize-remote-convergence
feature: file-validation
created: "2026-06-18"
---

# Impact Analysis: Converge Illegal-Char Filenames on Remote (Sanitize → Force-Upload → Delete Unsanitized)

## Goal

Change the sanitization model from **local-only** (today: remote keeps `>`, local
disk uses `＞`, metadata key = remote `>` path) to **full convergence** (both local
and remote use the sanitized `＞` name).

Proposed behavior:

- **Laptop on sync** (illegal char `>` is legal on macOS, so file exists on disk with literal `>`):
  scan metadata for keys containing illegal chars → sanitize (rename local disk file + change metadata key) → force-upload sanitized name to remote → delete the unsanitized name from remote.
- **Mobile on sync** (cannot hold `>` on disk at all): file already lands as `＞` locally via existing download sanitize → force-upload `＞` to remote → force remote to treat `>` as deleted.

Net effect both platforms: GitHub remote file renamed `>` → `＞`, metadata re-keyed `>` → `＞`, `localPath` field no longer needed afterward.

## What "the change" actually touches

The metadata **key is the GitHub remote path** everywhere in the engine
(`determineSyncActions`, `findConflicts`, `reconcileRemoteMetadataWithTree`,
`getRemoteFileContentWithFallback`, the `newTreeFiles` map keyed by `action.filePath`).
Convergence = **re-keying** an entry from `>`-path to `＞`-path, deleting the old key
on remote and creating the new one. This is not a new field — it mutates the primary
identity of a tracked file. The transition sync (the one that performs the rename) is
where every risk concentrates.

## Impact Analysis

| Area | File / Location | Effect | Risk |
|---|---|---|---|
| Migration scan (new) | `syncImpl()` before `determineSyncActions` (`sync-manager.ts:537`) | New pass over `metadataStore.data.files` keys matching `/[><:"\\|?*]/`. Each match: rename local file via `vault.adapter.rename`/write+remove, re-key metadata `>`→`＞` with `sha:null`, tombstone old `>` key (`deleted:true, deletedAt:now`). Cheap (O(files), no I/O unless illegal key found). | **Medium** — correct mechanically, but ordering vs `determineSyncActions`/`findConflicts` decides whether the old key resurrects |
| Remote rename atomicity | `commitSync` tree build (`sync-manager.ts:553-568`, `1245-1262`) | Same commit must carry `＞` blob (force add) AND `>` with `sha:null` (delete). GitHub tree applies both atomically in one commit → rename is atomic **on a single device**. | **Low** — single-commit rename is safe within one device |
| Cross-device resurrection | `determineSyncActions` deleted-vs-modified branch (`sync-manager.ts:993-1021`) + local-not-in-remote branch (`1064-1077`) | A second device holding local `>` + metadata `>` syncs after A renamed. **If migration SOFT-deletes** (tombstone `deleted:true, deletedAt:now`): B's `localFile.lastModified` is the old download time (`1334`), `deletedAt` is now → `deletedAt > lastModified` → `delete_local`. **Safe — no resurrection for an unmodified file.** Resurrect (`upload`) fires only if B genuinely edited the file *after* A's commit (`lastModified > deletedAt`) — normal concurrent-edit conflict, not spurious. **If migration HARD-deletes** the `>` key from the manifest instead: B falls into the local-not-in-remote branch (`1064`) → unconditional `upload` → resurrects even an unmodified file. | **Medium — conditional.** Safe with soft-delete tombstone; High only if migration hard-removes the key. Mitigation is a plan constraint, not an inherent risk |
| Re-download of converged file | `determineSyncActions` remote-not-in-local branch (`sync-manager.ts:1046-1061`) | Second device sees new remote key `＞`, no local `＞` → `download`. Device now holds BOTH `>` (old) and `＞` (new) on disk until a later `delete_local`. Two sync rounds to converge. | **Medium** — transient duplicate file on disk; converges but not in one pass |
| events-listener rename echo | `onRename`/`onCreate`/`onDelete` (`events-listener.ts:134-161`, `28-61`) | The programmatic local rename `>`→`＞` fires Obsidian `delete(>)` + `create(＞)`. `onDelete(>)` would mark the entry `deleted:true` and `onCreate(＞)` creates a fresh dirty entry — fighting the migration's own re-key. `resolveMetadataKey` (`events-listener.ts:163`) reverse-looks-up by `localPath`, partially masking this, but no `justDownloaded`-style guard exists for a programmatic *rename*. | **High** — programmatic rename races local event handlers; ghost/duplicate entries |
| `calculateSHA` / upload read | `sync-manager.ts:1101-1102`, `575`, `605` | Already resolve via `localPath ?? path`. After re-key, `path === localPath === ＞`, so `localPath` becomes redundant; entries written during migration must set the disk location consistently or `read`/`exists` miss. | **Medium** — fallback works only if migration writes both key and disk path coherently |
| Collision on rename | (documented limitation, README §Known Limitations) | If remote already has both `foo >.md` and `foo ＞.md`, renaming the first onto the second silently overwrites — now on the **canonical remote**, not just local disk. | **Medium** — rare, silent data loss; worse than today because it hits remote |
| Lossy permanent rename | whole feature | `＞` (U+FF1E) permanently replaces the real `>` on the canonical store and in GitHub history for all devices/consumers. Reverses the original design intent (preserve true name on remote). Irreversible. | **Medium** — irreversible + user-facing, but intended by the request |
| Mobile redundant upload | mobile `download`→`upload` of identical content | Mobile uploads a blob it just downloaded (same bytes). Wasteful, not incorrect. | **Low** |

## Cross-Feature Risks

- **sync** (`src/sync-manager.ts`): `determineSyncActions` (`964`) and `reconcileRemoteMetadataWithTree` (`765`) are keyed by remote path; the re-key event is invisible to them except as "old key deleted + new key added". The deleted-vs-modified timestamp logic at `993-1021` is the specific resurrection vector named above.
- **conflict-resolution** (`src/sync-manager.ts:1280`): the conflict-resolution write `vault.adapter.write(resolution.filePath, ...)` uses the **raw remote path, not sanitized/`localPath`**. If a file being migrated is simultaneously conflicting, this write targets the unsanitized `>` path → on mobile throws `FILE_NOTCREATED`, on laptop writes back the `>` file and undoes the migration. This path is already unsanitized today (see file-validation README §Update 2026-06-18).
- **events-listener** (`src/events-listener.ts`): `onRename`/`onCreate`/`onDelete` + `resolveMetadataKey`. Two uncommitted plans already touch this area (`sync/plans/plan-fix-events-localpath-lookup.md`, `plan-fix-events-listener-edge-cases.md`) — convergence adds a programmatic-rename suppression requirement on top of them. Must not be planned independently.
- **status-bar-indicator**: unaffected — reads sync state, not file identity.

## Edge Cases

- **Concurrent migration, two devices**: both scan the same `>` file and both attempt rename in the same window → second `commitSync` fails on stale branch-head SHA (`getBranchHeadSha` `sync-manager.ts:1264`) → retry path re-pulls; second device's `＞` add is a no-op (same path) but its `>` delete may race a re-add. Converges only if delete always wins.
- **Offline device returns post-migration, file NOT modified there**: holds local `>` + metadata `>` (old `lastModified`), remote has `＞` (new) and `>` soft-tombstoned (`deletedAt:now`). `deletedAt > lastModified` → `delete_local` → converges cleanly. **No resurrection.** Only condition: migration must SOFT-delete (keep key + tombstone), never hard-remove the `>` key — hard-remove routes to the local-not-in-remote `upload` branch (`1064`) and resurrects unconditionally.
- **Offline device returns, file modified there after migration**: `lastModified > deletedAt` → `upload` of `>` → this is a real concurrent edit (user changed `>` on B while A renamed it). Resurrects the illegal name, but it reflects genuine user intent/edit, so it surfaces as the normal last-writer conflict — acceptable, not a bug. `unclear — needs human input: confirm a post-migration edit re-creating the illegal name is acceptable (it re-enters the migration scan next sync anyway).`
- **Manifest/log/config files with illegal chars**: scan must exclude `${configDir}/${MANIFEST_FILE_NAME}` and the log file (already special-cased in `determineSyncActions:979` and `isSyncable`). Re-keying the manifest would corrupt sync.
- **Folder names with illegal chars** (`Books >/note.md`): sanitize is per-segment; renaming a folder segment on remote means moving every child path. The request says "file" — `unclear — needs human input: are illegal chars in folder segments in scope, or files only?`
- **Mobile ghost entries**: if events-listener previously created a ghost `＞` entry (pre-`resolveMetadataKey`), the migration may find both a `>` real entry and a `＞` ghost → double-tracking. Needs dedup during scan.
- **Idempotency**: after convergence no key matches the illegal-char regex → scan is a no-op on subsequent syncs. Tombstoned `>` entries linger until `removeVolatileArtifactsFromLocalMetadata` (`sync-manager.ts:693`) / retention prunes them. Confirm they don't re-trigger actions while lingering.

## Implementation Steps

N/A — analysis only.
