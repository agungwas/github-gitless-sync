---
last_updated: "2026-10-29"
updated_by_plan: "plan-first-install-and-log-modal.md"
decision: "DECISIONS.md — 2026-10-29 Repair First-Install Sync and Simplify Log Modal"
active_skill: ""
active_since: ""
---
# Community Plugin Sync

## Purpose

Opt-in (`settings.syncCommunityPlugins`) synchronization of Obsidian community plugins across devices: install, update, uninstall, enable/disable. Plugin binaries (`main.js`, `styles.css`) of registry plugins are NOT stored in git — each device downloads them from the plugin's GitHub release. Only `manifest.json`, `data.json` and `community-plugins.json` travel through git, as ordinary files.

`github-sync-metadata.json` keeps its pre-feature shape `{ lastSync, files }`; this feature adds no field to it.

## Files

| File | Role |
|---|---|
| `src/plugin-sync/coordinator.ts` | `PluginSyncCoordinator` — builds the reconciler when the feature is on; wraps native lifecycle calls; 15 s removal-scan timer. Never starts a sync. |
| `src/plugin-sync/reconciler.ts` | `PluginLifecycleReconciler` — `reconcile(completeSnapshot, hydrateIds)`, `observeLocalRemovals()`, `startObservingNativeMutations()`; in-memory `pendingHydrate` set |
| `src/plugin-sync/installer.ts` | `PluginPackageInstaller` — stage, backup, unload, promote, verify manifest id/version, rollback; `cleanupStaging()` |
| `src/plugin-sync/package-source.ts` | `OfficialPackageSource.resolve(manifest)` — registry lookup (`obsidianmd/obsidian-releases`), downloads from `releases/download/<manifest.version>`; returns `{ manifest, assets }` |
| `src/plugin-sync/path-policy.ts` | `classifyPath()` — share/local decision per path |
| `src/plugin-sync/runtime-bridge.ts` | `PluginRuntimeBridge` — wraps `installPlugin/uninstallPlugin/enablePlugin/disablePlugin`; per-id mutation lock + version |
| `src/plugin-sync/mutation-guard.ts`, `plugin-id.ts`, `reporter.ts` | `withStableMutation`, `validId`, per-plugin log/Notice reporting |
| `src/metadata-store.ts` | `normalizeMetadata()` (used by `load()` and remote parse); `save()` write queue survives a failed write |
| `src/sync-manager.ts` | Integration: `collectHydrateIds`, uninstall-conflict resolution, `preserveDesktopOnlyIds`, orphan cleanup |
| `src/events-listener.ts` | Defers plugin folder / `manifest.json` delete events (`isManagedPluginRemoval`) |
| `src/views/conflicts-resolution/plugin-uninstall-conflict.tsx` | Per-plugin uninstall conflict choice |

## Flows

### Path classification (`classifyPath`)
- Gitless's own folder: `share/self` only when `syncConfigDir` is on, otherwise `local/self`. Otherwise an ordinary file (no staging, no apply command).
- Explicit include pattern `plugins/<id>` → `legacy/custom`: whole folder via git, never hydrated.
- `community-plugins.json`, `plugins/<id>/manifest.json`, `plugins/<id>/data.json` → `share/managed` (`data.json` becomes local when excluded by an exact pattern, `settingsOptOut`).
- Any other file under `plugins/<id>/` → `local/managed`, cleanup `binary-migration` (remote copies of `main.js`/`styles.css` are deleted).

### Remote orphan cleanup
Desired-state paths are never orphaned regardless of the feature toggle, except a `data.json` the user excluded exactly.

### Hydration (`reconcile`)
After each sync with a complete pinned snapshot. For each local plugin folder (compatible, not custom, not self): hydrate `main.js`/`styles.css` only when the id is in `hydrateIds`, `main.js` is missing, or the id is in `pendingHydrate`. No hashing, receipts or proofs.
- `hydrateIds` = managed `manifest.json` download actions of this sync plus every manifest settled by a conflict resolution (except accept-uninstall).
- Failure: old binary restored, id added to `pendingHydrate` (lives for the Obsidian session); success removes it. A registry miss is reported as skipped, other errors as failed.
- Sync enabled state from `community-plugins.json` into Obsidian's in-memory saved startup list. State changes take effect after an Obsidian restart; a notice appears when they change. Existing runtime state is left alone, except when updating or uninstalling a package.
- A running plugin is unloaded during its package update and restored afterward. An inactive plugin stays inactive after installation or update, even if its saved startup state is enabled.

### Uninstall
- Local: native wrapper, or the removal scan (id absent for 2 consecutive scans), writes the ordinary tombstone `deleted: true`, `deletedAt` on `manifest.json` and `data.json`. Vault events do not fire for config-dir files, hence the wrapper and scan.
- Remote: manifest metadata `deleted === true` and folder exists → unload + `rmdir`.
- Conflict: remote manifest tombstoned and local manifest/`data.json` sha differs from metadata. `conflictHandling` `ask` → prompt; `overwriteLocal` → accept uninstall; `overwriteRemote` → keep local.

### Enabled list
`community-plugins.json` is a plain synced file (conflicts are ordinary file conflicts). Its enabled state is applied at the next app restart; the matching in-memory startup list is updated during sync so a later Obsidian save does not overwrite the file with stale state. On mobile, ids present in the remote list whose local manifest has `isDesktopOnly: true` are re-added to the local file before upload. The in-memory list uses an internal Obsidian API; behavior on physical mobile devices remains unverified.

### Sync triggers
Only manual, interval, startup, focus and blur syncs. Native install/uninstall/enable/disable never start one.

## Tests

`src/plugin-sync/*.test.ts`, `src/metadata-store.test.ts`, `src/github/client.test.ts`, `src/sync-manager.test.ts`, `src/views/conflicts-resolution/plugin-uninstall-*.test.tsx`. 25 files / 252 tests pass (2026-10-15). QA runbook: `qa/plan-native-community-plugin-sync/scenarios.md`.

## Known Constraints

- Mixed devices (feature on and off, `syncConfigDir` on) are unsupported: the feature-off device uploads `main.js`, feature-on devices delete it as binary migration. Enable the feature on all devices.
- A plugin not in the official registry (BRAT beta, dev, delisted) syncs only `manifest.json`/`data.json` unless the user adds an include pattern `plugins/<id>`; other devices log "not in the official registry".
- If the remote deletes Gitless's own files, `delete_local` applies normally.
- A hydrate failure is retried only within the Obsidian session; after a restart the old binary stays until the next manifest change or a missing `main.js`.
- A plugin reinstalled locally after a remote tombstone resurrects its entry on upload; it is not removed.
- Hand-edited official `main.js` is not detected; download integrity relies on HTTPS from GitHub.
- On a first sync an existing local plugin of another version is not re-hydrated (empty hydrate set); only missing `main.js` triggers it.
- Unverified: whether Obsidian mobile drops desktop-only ids from `community-plugins.json` (a 2022 report says yes, staff say it should not); the upload-time restore covers both cases.

### Update 2026-10-29 — first-install recovery

- Before each regular sync, `SyncManager.reconcileConfigDirFiles()` records new syncable config files and clears a local tombstone only when the file's mtime is later than `deletedAt`.
- When a remote live manifest and a local manifest tombstone both exist, `determineSyncActions()` compares remote `lastModified` with local `deletedAt`: the newer timestamp selects download or remote deletion. A managed remote deletion is allowed when the local plugin manifest is tombstoned. Equal timestamps produce no deletion action in that branch.
- `isPathMissing()` checks absence through `DataAdapter.exists()`; `ensureParentDirectory()` creates missing ancestors. `downloadFile()` skips matching-SHA downloads only when the destination is an existing file. Missing files are fetched; destination directories fail clearly.
- Successful downloads return accepted metadata to the frozen `localSnapshot`, preventing stale tombstones from being recommitted while keeping unrelated concurrent metadata out of the commit.
- Conflict-resolution parents are prepared before branch publication. A structured `ENOENT` write race gets one parent-creation retry; later local-write failures identify that a remote commit may already exist.
- Remote uninstall unloads the plugin and recursively removes its folder. `reconcile()` hydrates compatible plugins from their local manifest and reports registry, download, and runtime failures through `PluginSyncReporter`.
- Filesystem and lifecycle failure logs include path context and nested causes when logging is enabled. With logging disabled, automatic logger writes create no file and append no entries.
- The 15-second removal scan only considers IDs previously observed locally; it requires two absent scans, absence from the enabled list, no loaded plugin or active mutation, and an acknowledged manifest SHA before recording an uninstall.
- `src/plugin-sync/uninstall-sync.test.ts` now models missing plugin directories and rejects writes without parents; it checks committed metadata and a subsequent sync. It remains an in-memory single-device fixture, not a physical Mac/Android test.
