---
status: done
slug: sanitize-remote-convergence
created: "2026-06-18"
completed: "2026-06-18"
---

# Plan: Converge Illegal-Char Filenames on Remote

## Goal

Flip sanitization from local-only to full convergence. Files whose remote/metadata key
contains a mobile-illegal char (`> < : " | ? * \`) get renamed to the fullwidth-lookalike
name (`＞` etc.) on **both** local disk and the GitHub remote. After convergence the remote
no longer hosts illegal names, mobile never hits `FILE_NOTCREATED` for them, and the
`localPath` indirection is no longer needed for migrated files.

Mechanism (per sync): a migration scan re-keys each illegal metadata entry — soft-tombstone
the old `>` key (drives `delete_remote`) and create a new `＞` key with `sha:null` (drives
`upload`). One GitHub commit carries both → atomic rename. On laptop the on-disk `>` file is
physically renamed to `＞`; on mobile the file already lives at `＞` (existing download
sanitize), so only metadata is re-keyed.

Impact analysis: ./sanitize-remote-convergence-impact.md

## Approach

**Chosen (named by human):** Migration scan in `SyncManager`, reusing the existing
`justDownloaded` suppression flag + soft-delete tombstone. Per impact doc + discussion:

- **Old key = SOFT tombstone, never hard-removed.** `delete_remote` only fires when the local
  entry is `deleted:true` with `deletedAt > remoteFile.lastModified` (`determineSyncActions:1008-1020`).
  Hard-removing the key routes to the local-not-in-remote branch (`1064`) → unconditional
  `download`/`upload` → resurrects the illegal name. Tombstone is mandatory.
- **New key = `sha:null`** → local-not-in-remote branch (`1064`) → `upload` (force-add). On
  laptop the renamed disk file supplies content; on mobile the just-downloaded `＞` file does.
- **`justDownloaded` set true ONLY when a physical disk rename happens** (laptop). On mobile no
  disk rename fires, so no `create`/`modify` echo arrives to consume the flag — leaving it
  `true` would make the user's first real edit to `＞` get swallowed by `onModify`'s
  justDownloaded branch (`events-listener.ts:117-127`). So `justDownloaded: willRenameDisk`.
- **Explicit metadata op is the source of truth**, not the async vault-event echo. The echo is
  only *suppressed* (via `justDownloaded` + existing `resolveMetadataKey` reverse-lookup), not
  relied on — mobile event timing is unreliable.

**Rejected:** (a) rely on the rename echo alone to produce upload+tombstone — fragile on mobile;
(b) hard-delete + recreate keys — breaks `delete_remote`, resurrects; (c) build-fix only (no
remote rename) — leaves divergence + never migrates legacy `>` files stuck behind the
`downloadFile` early-return (`sync-manager.ts:1304`).

## Implementation Steps

### 1. `src/utils.ts` — illegal-char predicate
Add and export a predicate so the scan + tests don't re-derive the regex:
```ts
export function pathHasMobileIllegalChars(filePath: string): boolean {
  return sanitizePathForLocalFilesystem(filePath) !== filePath;
}
```
Reuses existing `sanitizePathForLocalFilesystem` / `MOBILE_ILLEGAL_CHAR_MAP`. No map change.

### 2. `src/metadata-store.ts` — no schema change
Confirm no new field needed: migration reuses existing `deleted`, `deletedAt`, `justDownloaded`,
`sha:null`. `localPath` stays for the existing local-only path. Add a one-line code comment on
`FileMetadata` noting `justDownloaded` is also set by filename migration (laptop disk-rename case).

### 3. `src/sync-manager.ts` — new `migrateIllegalFilenames()`
Add a private async method. Signature:
```ts
private async migrateIllegalFilenames(
  remoteMetadataFiles: { [key: string]: FileMetadata },
  remoteRepoFiles: { [key: string]: GetTreeResponseItem },
): Promise<Set<string>>   // returns the set of tombstoned OLD keys (for conflict exclusion)
```
Logic — iterate `Object.keys(this.metadataStore.data.files)`; for each `key`:
1. Skip if `this.isInternalSyncFile(key)` (manifest/log/workspace) — re-keying the manifest corrupts sync.
2. Let `entry = files[key]`. Skip if `entry.deleted`.
3. `const sanitizedKey = normalizePath(sanitizePathForLocalFilesystem(key))`. Skip if `sanitizedKey === normalizePath(key)` (no illegal char). NOTE: `sanitizePathForLocalFilesystem` already sanitizes **every** segment, so illegal chars in folder segments (`Books >/note.md` → `Books ＞/note.md`) are handled here automatically — folders ARE in scope (OQ2 resolved).
4. **Collision guard:** if (`files[sanitizedKey]` exists and not `deleted`) OR (`remoteMetadataFiles[sanitizedKey]` exists and not `deleted`) → `logger.warn("Skipping migration, target exists (collision)", {key, sanitizedKey})` and skip.
5. `const currentDisk = entry.localPath ?? normalizePath(key)`.
   `const willRename = currentDisk !== sanitizedKey`.
6. If `willRename`:
   - If `await this.vault.adapter.exists(currentDisk)`:
     - `const folder = normalizePath(sanitizedKey.split("/").slice(0,-1).join("/"))`; `mkdir` if non-empty and missing (wrap try/catch w/ path in message — project convention). This creates the sanitized folder (`Books ＞/`) when a folder segment was illegal.
     - `const buf = await this.vault.adapter.readBinary(currentDisk)` (binary-safe; wrap try/catch).
     - `await this.vault.adapter.writeBinary(sanitizedKey, buf)` (wrap try/catch).
     - `await this.vault.adapter.remove(currentDisk)` (wrap try/catch).
   - Else (OQ3 resolved = yes): `logger.warn("Migration source missing on disk", currentDisk)` — still re-key metadata so remote converges. The `＞` upload finds no local content → determineSyncActions upload branch (`575-592`) routes to `delete_remote`; net = file removed everywhere. Accepted.
7. Re-key metadata:
   - `files[sanitizedKey] = { path: sanitizedKey, sha: null, dirty: true, justDownloaded: willRename, lastModified: Date.now() }`
   - `entry.deleted = true; entry.deletedAt = Date.now();`  // soft tombstone old key
   - add `key` to `migratedOldKeys`
8. After the loop, if `migratedOldKeys.size > 0`: `await this.metadataStore.save()` and `logger.info("Migrated illegal filenames", {count})`. Return `migratedOldKeys`.

### 4. `src/sync-manager.ts` — wire into `syncImpl`
After `await this.reconcileRemoteMetadataWithTree(...)` (`~line 488`) and BEFORE
`const conflicts = await this.findConflicts(...)` (`~490`):
```ts
const migratedOldKeys = await this.migrateIllegalFilenames(remoteMetadata.files, files);
```
Then after `findConflicts` returns, exclude migrated old keys from conflicts (they are being
deleted remotely, not real conflicts). **Load-bearing (OQ1 resolved = migrate anyway):** a file
whose remote sha changed since last sync is migrated regardless; this exclusion is what prevents
it surfacing as a spurious conflict — the `>` tombstone → `delete_remote`, the `＞` upload carries
local content:
```ts
const filteredConflicts = conflicts.filter(c => !migratedOldKeys.has(c.filePath));
```
Use `filteredConflicts` everywhere `conflicts` was used below this point.

### 5. `src/sync-manager.ts:1280` — fix conflict-resolution write (cross-feature landmine)
The conflict write uses the raw remote path, unsanitized — on mobile it throws
`FILE_NOTCREATED`, on laptop it rewrites the `>` file and undoes migration. Resolve like the
other sites:
```ts
const writePath = this.metadataStore.data.files[resolution.filePath]?.localPath
  ?? normalizePath(resolution.filePath);
await this.vault.adapter.write(writePath, resolution.content);
```

### 6. `src/events-listener.ts` — verify echo handling (likely no code change)
Confirm the laptop disk-rename echo is absorbed by existing logic:
- `onCreate(＞)` → `resolveMetadataKey("＞")` returns `＞` (entry now exists) → `justDownloaded:true`
  → flips to false, returns. No ghost, `sha:null` preserved. ✅
- `onDelete(">")` → entry exists (tombstoned) → re-marks `deleted` + `deletedAt`. Idempotent;
  the newer `deletedAt` is still > remote `lastModified`. ✅
- A single `rename` event resolves to `onCreate(＞)+onDelete(>)` (`events-listener.ts:145-151`) → same.
If a test proves a gap, add the minimal guard here — but expect none.

## Open Questions — RESOLVED (2026-06-18)

- **OQ1 — Remote-changed-during-migration:** RESOLVED = **migrate anyway + rely on conflict exclusion**
  (step 4). No defer guard. The `migratedOldKeys` filter prevents the spurious conflict.
- **OQ2 — Folder segments with illegal chars** (`Books >/note.md`): RESOLVED = **in scope**. Handled
  automatically by per-segment `sanitizePathForLocalFilesystem`; `mkdir` in step 6 creates the
  sanitized folder. No special-casing. Empty source folder (`Books >/`) may linger on local disk
  (cosmetic) — see Edge Cases.
- **OQ3 — Migration source missing on disk:** RESOLVED = **yes, re-key anyway**; `＞` upload finds no
  content → routes to delete_remote → file removed everywhere. Accepted (step 6 else-branch).

## Test Scenarios (for iris-2)

- **T1 (laptop rename):** entry key `Books/x >.md` exists, disk file at `Books/x >.md`, no `localPath`.
  After migrate: disk file at `Books/x ＞.md`, old gone; `files["Books/x ＞.md"]` = `{sha:null, dirty:true, justDownloaded:true}`; `files["Books/x >.md"].deleted===true` with `deletedAt`.
- **T2 (mobile, no disk rename):** entry key `x >.md` with `localPath:"x ＞.md"`, disk already at `x ＞.md`.
  After migrate: no disk I/O; `files["x ＞.md"].justDownloaded===false`; old key tombstoned.
- **T3 (no illegal char):** clean key untouched, not in returned set.
- **T4 (collision):** both `x >.md` and `x ＞.md` tracked & not deleted → `x >.md` skipped, warn logged, no re-key.
- **T5 (remote changed):** `remoteMetadataFiles["x >.md"].sha !== entry.sha` → migrated anyway (in set, tombstone + new key created).
- **T5b (folder segment):** key `Books >/note.md` (disk file under `Books >/`) → migrated to `Books ＞/note.md`; `mkdir("Books ＞")` called; new key `Books ＞/note.md`, old tombstoned.
- **T6 (internal file):** manifest/log key with illegal char (synthetic) → skipped.
- **T7 (diff engine):** after migrate, `determineSyncActions` emits `upload` for `＞` and `delete_remote` for `>`.
- **T8 (conflict exclusion):** a migrated old key that would otherwise flag a conflict is filtered out of `conflicts`.
- **T9 (echo suppression):** simulate `onCreate("x ＞.md")` post-migrate (justDownloaded:true) → flips false, no second entry; `onDelete("x >.md")` → stays deleted.
- **T10 (conflict write path):** conflict resolution for a file with `localPath` writes to `localPath`, not the raw `>` path.
- **T11 (idempotency):** second migrate run with no illegal keys → returns empty set, no save, no actions.

## Deviations

| # | Planned | Actual | Reason | Update feature doc? |
|---|---|---|---|---|
| — | (filled by iris-3) | | | |

## Edge Cases

| Case | Handling | Update feature doc? |
|---|---|---|
| Two devices migrate same file concurrently | Second `commitSync` hits stale branch-head SHA → retry re-pulls; `＞` add idempotent, `>` delete must win | yes |
| Offline device returns, file unmodified | Soft tombstone `deletedAt`(now) > old `lastModified` → `delete_local`, clean converge | yes |
| Offline device returns, file edited after migration | `lastModified > deletedAt` → `upload` of `>` = genuine concurrent edit; re-enters scan next sync | yes |
| Collision (`foo >` + `foo ＞` both remote) | Skip + warn (step 4), no silent overwrite | yes |
| Folder segment illegal char | In scope; per-segment sanitize + mkdir handles it (OQ2) | yes |
| Empty source folder after file moved out (`Books >/`) | Lingers on local disk (cosmetic); remote has no empty dirs so it vanishes there. Out of scope to clean | yes |
| Remote sha changed for a migrating file | Migrate anyway; `migratedOldKeys` excludes it from conflict (OQ1) | yes |
| Disk source missing on rename | Re-key anyway → `＞` upload no content → delete_remote → removed everywhere (OQ3) | yes |
| Lingering `>` tombstones | Pruned by `removeVolatileArtifactsFromLocalMetadata` / retention; must not re-trigger actions while present | no |

## Affected Features

- **file-validation** (primary) — this plan.
- **sync** — `migrateIllegalFilenames` wired into `syncImpl`; `determineSyncActions` upload/delete_remote behavior relied on (no change to that method).
- **conflict-resolution** — `sync-manager.ts:1280` write path fixed to honor `localPath`.
- **events-listener** — echo suppression verified; change only if a test exposes a gap.
