---
---
# Impact Analysis: Config Dir Mid-Session Plugin Install Not Synced

## Goal (change description)

Ensure that when a user installs an Obsidian plugin mid-session (after Obsidian started,
before the next sync), the newly installed plugin files are picked up by the next sync,
given `syncConfigDir = true`.

**Not an Obsidian limitation.** The plugin CAN compensate — see root cause.

Implementation steps: N/A — analysis only.

---

## Root Cause

Obsidian's community plugin installer writes files at the **adapter level**
(`vault.adapter.write()`), not through the Vault API (`vault.create()`/`vault.modify()`).
Adapter-level writes do **not** fire `vault.on('create')` events.

Therefore, `EventsListener.onCreate()` in `src/events-listener.ts:28` is **never called**
for newly installed plugin files. They are never added to `metadataStore.data.files`.

`syncImpl()` at `src/sync-manager.ts:418` builds `determineSyncActions()` from
`metadataStore.data.files`. Files not in metadata are **invisible to sync** — they
appear neither in "common files" nor in "local only" checks.

### The existing partial fix (startup-only)

`loadMetadata()` at `src/sync-manager.ts:1182` has a reconciliation branch:

```
} else if (this.settings.syncConfigDir) {
  // walk vault.configDir, add any file NOT already in metadata with sha=null
```

This runs **once at plugin startup**. It covers the case where `syncConfigDir` was just
enabled, or where files were added before Obsidian started. It does **not** cover
mid-session plugin installation — files installed after Obsidian is running and before
the next restart are invisible until the next Obsidian restart.

### Confidence

Confirmed. `isSyncable()` at `src/events-listener.ts:160` correctly allows configDir
files when `syncConfigDir=true`. The failure is not in filtering — it's that the
event never fires in the first place.

---

## Impact Analysis

| Code Path | Impact | Risk |
|---|---|---|
| `syncImpl()` — `src/sync-manager.ts:418` | Entry point for regular sync. Currently does not call any configDir scan. Any change would be added here. | **Medium** — central path, called on every user-triggered and interval sync. A bug here affects all syncs, not just the configDir case. |
| `metadataStore.data.files` — `src/metadata-store.ts:35` | New entries with `sha=null, dirty=false` would be added for newly discovered plugin files. | **Low** — additive change; existing entries are not touched (reconciliation logic checks `!this.metadataStore.data.files[filePath]` before writing). |
| `findConflicts()` — `src/sync-manager.ts:763` | New files with `sha=null` that ALSO appear in remote metadata enter the conflict check. `localFile.sha=null` means both `remoteFileHasBeenModifiedSinceLastSync` and `localFileHasBeenModifiedSinceLastSync` evaluate to `true`. The third condition `actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA` is the real guard. If content is identical, no conflict (correct). If content differs, conflict UI shown (also correct). | **Low** — existing logic handles sha=null correctly via the third condition. No false positives for identical files. |
| `determineSyncActions()` — `src/sync-manager.ts:852` | New files not in remote → "local only" path → `upload` action. New files in remote → `calculateSHA()` is `actualLocalSHA`; if `remoteFile.sha === actualLocalSHA` → no action (same content); if differs → `upload` (since `localFile.sha=null !== actualLocalSHA`). | **Low** — SHA comparison correctly determines direction for known content. The null sha means "never tracked here", so uploading local is correct unless conflict detection fires first. |
| `commitSync()` — `src/sync-manager.ts:1012` | No direct change. New uploads flow through the existing upload path (text vs binary detection, blob creation for binary). | **Low** — no change needed. |
| `loadMetadata()` — `src/sync-manager.ts:1182` | Contains the exact reconciliation logic that is needed. If extracted and reused at sync time, code is shared. If duplicated, divergence risk. | **Low** (reuse path) / **Medium** (duplication path) |
| Performance — mobile | Scanning `vault.configDir` recursively on EVERY sync adds O(n) filesystem calls where n = number of configDir files. For users with many plugins (100+ files possible), this runs on every interval sync too. Mobile filesystem is slower than desktop. | **Medium** — bounded cost per sync, but multiplied by sync frequency. Interval sync users feel this on every tick. |

---

## Cross-Feature Risks

| Feature / File | Risk | Why |
|---|---|---|
| `src/events-listener.ts` — `isSyncable()` | **None** — read-only risk. Already correctly returns `true` for configDir files when `syncConfigDir=true`. No change needed here. A reconciliation scan at sync time would bypass this filter entirely (using the adapter list, not events), so `isSyncable` is irrelevant for the new path. | N/A |
| `src/settings/settings.ts` — `syncConfigDir` toggle | **Low** — existing `addConfigDirToMetadata()` / `removeConfigDirFromMetadata()` run when toggle changes in settings tab. A sync-time scan must also respect `syncConfigDir=false` to avoid adding configDir files when the user disabled the setting mid-session. Currently `loadMetadata()` wraps the reconciliation in `else if (this.settings.syncConfigDir)` — any reuse of this logic inherits this guard. | Check that guard is preserved. |
| `src/views/conflicts-resolution/view.tsx` | **None** — conflict detection logic unchanged. New plugin files with sha=null handled correctly by existing third condition in `findConflicts()`. | N/A |
| Interval sync path (`startSyncInterval`) — `src/sync-manager.ts:1357` | **Medium** — interval sync calls `sync()` → `syncImpl()`. If a configDir scan is added to `syncImpl()`, it runs on EVERY interval tick, not just on user-triggered syncs. This amplifies the performance impact above. | Consider whether scan should only run on explicit user-triggered sync vs. interval. |

---

## Edge Cases

| Case | Expected behavior | Status |
|---|---|---|
| Plugin installed AND immediately deleted before sync | File appears on disk then disappears. `onDelete` event fires (delete IS adapter-level but Obsidian does fire it through vault for explicit deletes). If delete event fired: metadata has `deleted=true`. Reconciliation checks `!metadata[filePath]` — file IS there → not re-added. No upload, no conflict. If delete event NOT fired: file not on disk when reconciliation scan runs → not found → not added. Either way: correct, nothing to sync. | Likely correct, event firing on delete needs confirmation. |
| Plugin previously deleted (`deleted=true` in metadata), then reinstalled | Reconciliation check: `!metadata[filePath]` — file IS there (with `deleted=true`) → **NOT re-added**. File stays `deleted=true`. In `determineSyncActions()` "common files" path: if remote also has `deleted=false` (Vault B still has it), the timestamp comparison runs. If remote `lastModified > deletedAt` → download (overwrites local reinstall). This is **incorrect behavior** for the reinstall case. | **Pre-existing gap** — not introduced by the proposed change, but a sync-time scan would inherit it. The reconciliation logic must also handle the `deleted=true` + file-exists-on-disk case. |
| Hidden files in configDir (`.`-prefixed names) | `firstSyncFromRemote` explicitly skips hidden files (`targetPath.split("/").last()?.startsWith(".")` check at `sync-manager.ts:245`). Regular sync and reconciliation do NOT filter hidden files. If a reconciliation scan adds `.DS_Store` or other OS artifacts to metadata, they get uploaded. | **Gap** — hidden file filtering is inconsistent between first sync and regular sync. A sync-time configDir scan would need explicit hidden file exclusion to match first-sync behavior. |
| User has many plugins (100+ configDir files) + interval sync every 1 min | On every tick: recursive adapter list over configDir. On mobile, filesystem ops are slower. With a 1-minute interval and a large configDir (~200 files), this runs 60 times/hour. | Acceptable if scan exits early once metadata is already populated (all files found = already tracked). Worst case on first scan after install. |
| `syncConfigDir` toggled OFF after mid-session install (before sync) | When user disables `syncConfigDir`, `removeConfigDirFromMetadata()` is called from settings tab. That removes configDir entries. If reconciliation at sync time also checks `syncConfigDir`, it skips the scan. Files never uploaded. Correct. | Correct — inherits existing toggle guard. |
| Two vaults both install different versions of same plugin between syncs | Vault B installs plugin v1.1. Remote has v1.0 (from Vault A). Reconciliation adds files with `sha=null`. `findConflicts()`: `remoteFile.sha=sha_1.0 !== null` (true), `actualLocalSHA=sha_1.1 !== null` (true), `sha_1.0 !== sha_1.1` (true) → **conflict shown**. User resolves. | Correct — genuine conflict, system handles it. |
| Plugin file exists in configDir but is a directory (plugin sub-folder) | `vault.adapter.list()` returns `files` and `folders` separately. Reconciliation walks folders recursively and only adds from `files`. Folders are never added to metadata. | Correct — no change needed. |
