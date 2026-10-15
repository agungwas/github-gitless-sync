---
last_updated: "2026-10-15"
updated_by_plan: "plan-native-community-plugin-sync.md (Update 2026-10-15)"
decision: "DECISIONS.md — 2026-10-15 Metadata-Neutral Community Plugin Sync"
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
- Then enable/disable to match `community-plugins.json`.

### Uninstall
- Local: native wrapper, or the removal scan (id absent for 2 consecutive scans), writes the ordinary tombstone `deleted: true`, `deletedAt` on `manifest.json` and `data.json`. Vault events do not fire for config-dir files, hence the wrapper and scan.
- Remote: manifest metadata `deleted === true` and folder exists → unload + `rmdir`.
- Conflict: remote manifest tombstoned and local manifest/`data.json` sha differs from metadata. `conflictHandling` `ask` → prompt; `overwriteLocal` → accept uninstall; `overwriteRemote` → keep local.

### Enabled list
`community-plugins.json` is a plain synced file (conflicts are ordinary file conflicts). On mobile, ids present in the remote list whose local manifest has `isDesktopOnly: true` are re-added to the local file before upload.

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
