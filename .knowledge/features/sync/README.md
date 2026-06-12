# Sync Feature

Last updated: 2026-06-06
Updated by plan: PLAN_conflict-and-settings.md

## Files

| File | Role |
|---|---|
| `src/sync-manager.ts` | Core sync logic — `SyncManager` class (1392 lines) |
| `src/metadata-store.ts` | `MetadataStore` + `FileMetadata`/`Metadata` interfaces |
| `src/events-listener.ts` | `EventsListener` — tracks vault FS events, updates metadata |
| `src/github/client.ts` | `GithubClient` — all GitHub REST API calls |
| `src/settings/settings.ts` | `GitHubSyncSettings` interface + `DEFAULT_SETTINGS` |
| `src/main.ts` | `GitHubSyncPlugin` — plugin entrypoint, wires everything together |

## Data Model

**Metadata file** — `{vault.configDir}/github-sync-metadata.json` (constant `MANIFEST_FILE_NAME`)

```ts
interface Metadata {
  lastSync: number;           // epoch ms of last sync
  files: { [path: string]: FileMetadata };
}

interface FileMetadata {
  path: string;
  sha: string | null;         // git blob SHA at last sync; null = never synced
  dirty: boolean;             // modified locally since last sync
  justDownloaded: boolean;    // set true on download, cleared on next FS event
  lastModified: number;       // epoch ms
  deleted?: boolean | null;
  deletedAt?: number | null;  // epoch ms of deletion
}
```

Metadata is written via a serial write queue (`MetadataStore.writeQueue`) to prevent concurrent writes.

## Sync Flows

### First Sync (`firstSync()` → `firstSyncImpl()`)

Guarded by `this.syncing` flag.

1. Call `getRepoContent()`. Handle 409 (bare repo, no commits) and 404 (no files) as "remote is empty".
2. **Remote empty**: create manifest file via `createFile()` (only place this API is used), then re-fetch content to get a valid tree SHA.
3. Check `vaultIsEmpty()` — returns true if vault has no files (ignores configDir, which is always present).
4. **Both non-empty**: throw `"Both remote and local have files, can't sync"`.
5. **Remote empty (or was)**: `firstSyncFromLocal()` — builds tree from local metadata, calls `commitSync()`.
6. **Vault empty**: `firstSyncFromRemote()` — downloads ZIP archive, extracts sequentially (avoids memory crash on large vaults), populates metadata, then `commitSync()`.

**ZIP extraction notes** (`firstSyncFromRemote`):
- Strips first path segment (GitHub ZIP always wraps in a root dir)
- Skips: root dir entry, configDir files if `syncConfigDir=false` (except manifest), log file, hidden files (`.`-prefixed)
- Binary files: `vault.adapter.writeBinary()`
- After extraction, adds any local-only metadata files to tree and commits

### Regular Sync (`sync()` → `syncImpl()`)

Guarded by `this.syncing` flag. Shows Obsidian `Notice` during sync.

```
syncImpl():
  0. reconcileConfigDirFiles()                 → add untracked configDir files to metadata
  1. getRepoContent()                          → files (tree), treeSha
  2. fetch remote manifest blob                → remoteMetadata
  3. removeVolatileArtifactsFromLocalMetadata()
  4. filterRemoteMetadataFiles()               → strip volatile from remote metadata
  5. reconcileRemoteMetadataWithTree()         → fix stale SHAs in remote metadata
  6. findConflicts()                           → ConflictFile[]
  7. resolve conflicts (per conflictHandling setting)
  8. determineSyncActions()                    → SyncAction[]
  9. apply upload/delete_remote to newTreeFiles dict
  10. parallel: download files + delete local files
  11. commitSync(newTreeFiles, treeSha, conflictResolutions)
```

### Conflict Detection (`findConflicts()`)

A file is a conflict when **all three** conditions hold:
- `remoteFile.sha !== localFile.sha` (remote changed since last sync)
- `actualLocalSHA !== localFile.sha` (local changed since last sync)
- `remoteFile.sha !== actualLocalSHA` (files are actually different, not accidentally equal)

`actualLocalSHA` = git blob SHA computed on disk via `calculateSHA()`.

Remote content fetched via `getRemoteFileContentWithFallback()` — tries metadata SHA first, falls back to tree SHA on 404 (stale blob).

Internal sync files (`MANIFEST_FILE_NAME`, log file) are never checked for conflicts.

### Action Determination (`determineSyncActions()`)

| Scenario | Action |
|---|---|
| Both deleted | none |
| Remote deleted, local exists, `deletedAt > lastModified` | `delete_local` |
| Remote deleted, local exists, `lastModified > deletedAt` | `upload` |
| Local deleted, remote exists, `lastModified > deletedAt` | `download` |
| Local deleted, remote exists, `deletedAt > lastModified` | `delete_remote` |
| Remote SHA == actual local SHA | none |
| Actual local SHA ≠ tracked local SHA (local changed) | `upload` |
| Actual local SHA == tracked local SHA (remote changed) | `download` |
| File in remote only | `download` |
| File in local only | `upload` |

Config dir files filtered out if `syncConfigDir=false` (except manifest).

### Commit Process (`commitSync()`)

1. Update `metadataStore.data.lastSync = syncTime`
2. For text files: compute SHA via `calculateSHA()`, store in metadata
3. For binary files: `createBlob()` → get SHA, remove `content` from tree item (can't have both `sha` and `content`)
4. Inline manifest JSON as `content` in tree item (replaces any `sha`)
5. `createTree({ tree, base_tree: treeSha })` → newTreeSha
6. `getBranchHeadSha()` → branchHeadSha
7. `buildCommitMessage(template, deviceName)` → message string, then `createCommit({ message, treeSha: newTreeSha, parent: branchHeadSha })` → commitSha
8. `updateBranchHead({ sha: commitSha })`
9. Write conflict resolutions to disk
10. Save metadata

**Commit message template** (`gitless-commit-message-template` in `localStorage`, default: `"Sync at {YYYY-MM-DD HH:mm}"`). 
- Configurable under the "Device Specific" section in the settings tab.
- This is stored locally and will NOT be synced across devices.
- Any `{TOKEN}` → `moment().format(TOKEN)` via Obsidian's bundled moment.js
- Invalid moment token → kept as `{TOKEN}` literally (signals misconfiguration, doesn't crash)

## GitHub API Calls (via `GithubClient`)

All calls use `requestUrl` (Obsidian's cross-platform HTTP). Auth: `Bearer {githubToken}`, API version `2022-11-28`. Retry logic: `retryUntil()` from `src/utils.ts`, retries on 422; most paths use `retry=true, maxRetries=5`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/repos/{owner}/{repo}/git/trees/{branch}?recursive=1` | Get full file tree |
| GET | `/repos/{owner}/{repo}/git/blobs/{sha}` | Get blob content (base64) |
| POST | `/repos/{owner}/{repo}/git/blobs` | Upload binary blob |
| POST | `/repos/{owner}/{repo}/git/trees` | Create new tree |
| POST | `/repos/{owner}/{repo}/git/commits` | Create commit |
| GET | `/repos/{owner}/{repo}/git/refs/heads/{branch}` | Get branch HEAD SHA |
| PATCH | `/repos/{owner}/{repo}/git/refs/heads/{branch}` | Update branch HEAD |
| PUT | `/repos/{owner}/{repo}/contents/{path}` | Create file (first sync bare repo only) |
| GET | `/repos/{owner}/{repo}/zipball/{branch}` | Download ZIP archive |

## Volatile Files (Never Synced)

- `{configDir}/github-sync.log` (`LOG_FILE_NAME`)
- `{configDir}/workspace.json`
- `{configDir}/workspace-mobile.json`

`isVolatileSyncArtifact()` / `isSyncable()` enforce this. Volatile files removed from local metadata on every sync via `removeVolatileArtifactsFromLocalMetadata()`.

## Config Dir Sync

Controlled by `settings.syncConfigDir` (default: false).

- `addConfigDirToMetadata()` — walk `vault.configDir`, add all files to metadata (except volatile); called when toggle enabled in settings tab
- `removeConfigDirFromMetadata()` — remove all configDir entries (except manifest); called when toggle disabled
- `reconcileConfigDirFiles()` — private method called at two points:
  1. Inside `loadMetadata()` when `syncConfigDir=true` and metadata already exists
  2. At the start of every `syncImpl()` (catches mid-session plugin/theme installs that bypass vault events)

  Walks `vault.configDir` recursively via `vault.adapter.list()`. Per-file logic:
  - Skips: volatile files (`isVolatileSyncArtifact()`), hidden files (`.`-prefixed filename)
  - **Case A** — file not in metadata: adds entry with `sha=null, dirty=false, lastModified=Date.now()`
  - **Case B** — file in metadata with `deleted=true`: calls `vault.adapter.stat()` — resets entry (`sha=null, deleted=false, lastModified=stat.mtime`) only if `stat.mtime > deletedAt` (confirms reinstall, not phantom); skips if stat is null or file predates deletion
  - Saves metadata if anything changed

  Covers plugins AND themes — walks entire configDir, not just `plugins/` subdirectory.


## Events Listener (`EventsListener`)

Registered after `onLayoutReady` to avoid create-event spam on startup.

| Event | Behavior |
|---|---|
| `create` | If `justDownloaded=true`: clear flag. Else: add/reset file in metadata (`sha=null, dirty=true`) |
| `delete` (file) | Mark `deleted=true, deletedAt=now` |
| `delete` (folder) | Mark all tracked children `deleted=true` |
| `modify` | If `justDownloaded=true`: clear flag. Else: update `lastModified`, set `dirty=true` |
| `rename` | `onDelete(oldPath)` + `onCreate(newFile)` |

`isSyncable()` rules:
- Manifest: always syncable
- `workspace.json`, `workspace-mobile.json`, log file: never
- configDir files: only if `syncConfigDir=true`
- All other files: yes

## Concurrency

`this.syncing: boolean` flag in `SyncManager`. Both `firstSync()` and `sync()` check and set it — prevents concurrent syncs. Not a lock; race possible if two sync triggers fire in the same JS tick (unlikely in practice).

## Interval Sync

`startSyncInterval(minutes)` / `stopSyncInterval()` / `restartSyncInterval()` — wraps `window.setInterval`. Plugin registers the interval ID via `this.registerInterval()` for auto-cleanup on unload.

## Conflict Resolution Handoff

`SyncManager` receives `onConflicts: (conflicts: ConflictFile[]) => Promise<ConflictResolution[]>` callback in constructor. On conflict, blocks sync with `await this.onConflicts(conflicts)` until all conflicts resolved.

`GitHubSyncPlugin.onConflicts()` stores conflicts, opens `ConflictsResolutionView`, returns a `Promise` resolved by `conflictsResolver` when user submits resolutions. Conflict files kept on plugin for view rebuild if user closes/reopens the view.

## Cross-Module Links

- `SyncManager` → `MetadataStore`: read/write file tracking state
- `SyncManager` → `GithubClient`: all GitHub API calls
- `SyncManager` → `EventsListener`: started via `startEventsListener(plugin)`, passed MetadataStore ref
- `SyncManager` → `ConflictsResolutionView`: via `onConflicts` callback (injected by plugin, not a direct import)
- `GitHubSyncPlugin` → `SyncManager`: orchestrates all sync entry points
- `GitHubSyncPlugin` → `ConflictsResolutionView`: opens view, sets conflicts, holds resolver

## SHA Algorithm

`calculateSHA(filePath)` implements git blob SHA:
```
SHA1("blob " + byteLength + "\0" + fileBytes)
```
Used to detect local changes without trusting `lastModified` timestamps. Returns `null` if file doesn't exist.

## Known Gaps / TODOs in Code

- `commitSync`: TODO comment about not reverting SHA updates on sync failure
- `determineSyncActions`: TODO in remote-deleted/local-missing case about removing remote reference
- `isSyncable()` in `EventsListener` has an edge case: all non-configDir files pass even if outside vault root (not reachable in practice via Obsidian events)
- `reconcileConfigDirFiles()` not called in `firstSyncImpl()` path — if user installs plugin after startup but before first sync, `firstSyncFromLocal()` may miss those files (rare; files installed before startup are caught by `loadMetadata()` at startup)
