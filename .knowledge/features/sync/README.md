---
last_updated: "2026-07-05"
updated_by_plan: "plan-fix-syncconfigdir-remote-orphans.md"
decision: "2026-07-05 — Widen Remote-Orphan Cleanup to Cover syncConfigDir-Off Files"
---
# Sync Feature


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
  localPath?: string;         // sanitized local filesystem path; set when remote path contains platform-illegal chars
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

All sync flows are initiated via the plugin's `sync()` entrypoint, which first forces all open text editors to flush their in-memory changes to disk (by awaiting `save()` on all open `TextFileView` instances) to prevent uploading stale data (critical on mobile).

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
- Sanitizes path segments containing platform-illegal chars (`>`, `<`, `:`, `"`, `|`, `?`, `*`, `\`) using Unicode fullwidth lookalikes before write
- Binary files: `vault.adapter.writeBinary()`
- After extraction, adds any local-only metadata files to tree and commits

### Regular Sync (`sync()` → `syncImpl()`)

Guarded by `this.syncing` flag. Shows Obsidian `Notice` during sync.

```
syncImpl(): Promise<number>                    → count of exclude/syncConfigDir-driven remote deletes this run
  0. reconcileConfigDirFiles()                 → add untracked configDir files to metadata
  1. getRepoContent()                          → files (tree), treeSha
  2. fetch remote manifest blob                → remoteMetadata
  3. removeVolatileArtifactsFromLocalMetadata()
  4. filterRemoteMetadataFiles()               → strip volatile from remote metadata
  5. reconcileRemoteMetadataWithTree()         → fix stale SHAs in remote metadata
  5.5. migrateIllegalFilenames()               → migratedOldKeys (Set<string>)
  6. findConflicts()                           → ConflictFile[] (excluding migratedOldKeys)
  7. resolve conflicts (per conflictHandling setting)
  8. determineSyncActions() + computeExcludedRemoteOrphans() → SyncAction[] (the latter appends delete_remote for paths isPathSyncable() now says aren't synced but are still in the raw remote tree)
  9. apply upload/delete_remote to newTreeFiles dict
  10. parallel: download files + delete local files
  11. commitSync(newTreeFiles, treeSha, conflictResolutions)
  12. return excludedRemoteOrphans.length        → sync() appends "(N removed from remote due to exclude patterns)" to the success Notice when > 0
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
| `delete` (folder) | Mark all tracked children whose `localPath` (or path) starts with the deleted folder's prefix as `deleted=true` |
| `modify` | If metadata is undefined: return early. Else if `justDownloaded=true`: clear flag. Else: update `lastModified`, set `dirty=true` |
| `rename` | `onDelete(oldPath)` + `onCreate(newFile)` |

`isSyncable()` rules:
- Manifest: always syncable
- `workspace.json`, `workspace-mobile.json`, log file: never
- configDir files: only if `syncConfigDir=true`
- All other files: yes

## Concurrency

`this.syncing: boolean` flag in `SyncManager`. Both `firstSync()` and `sync()` check and set it — prevents concurrent syncs. Not a lock; race possible if two sync triggers fire in the same JS tick (unlikely in practice). If triggered while `this.syncing` is true, an Obsidian `Notice` is shown ("First sync already in progress" or "Sync already in progress") and the execution aborts early.

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

## File Filtering — Pattern-Based Exclusion (`excludePatterns` / `includePatterns`)

Added 2026-07-04 (`plan-exclude-patterns.md`), hardened 2026-07-05 (`plan-fix-exclude-patterns-qa-findings.md`, `plan-harden-exclude-patterns.md`). Two settings arrays, gitignore-style glob (`*`, `**`, trailing `/` = dir + everything under it), matched by the pure function `isExcludedPath(filePath, excludePatterns, includePatterns)` in `src/sync-filters.ts`:

```
isExcludedPath = matchesAny(filePath, excludePatterns) && !matchesAny(filePath, includePatterns)
```

Include always wins regardless of list order or edit recency. Blank/whitespace entries and patterns over `MAX_PATTERN_LENGTH` (500 chars) are ignored, never treated as match-all. The glob matcher (`matchSegment` + `matchSegmentSequence` in `sync-filters.ts`) is a two-pointer/DP implementation, not backtracking regex — deliberately built this way to stay `O(n*m)` and immune to ReDoS on adversarial patterns.

`shouldSkipFile(filePath)` in `sync-manager.ts:698` is the base choke point: manifest path is always exempt (checked first, before pattern matching), then `isVolatileSyncArtifact()` (log file, 2 workspace files), then `isExcludedPath()`. All 9 filtering call sites route through it:

| Location | Function | What it filters |
|---|---|---|
| `events-listener.ts:192` | `isSyncable()` | Live FS events (create/delete/modify/rename) |
| `sync-manager.ts:269` | (ZIP extraction, `firstSyncFromRemote()`) | Skips excluded entries when writing to disk |
| `sync-manager.ts:699` / `filterRemoteMetadataFiles()` | Strips excluded + volatile files from remote metadata each sync |
| `sync-manager.ts:726` / `removeVolatileArtifactsFromLocalMetadata()` | Strips excluded + volatile files from local metadata each sync |
| `sync-manager.ts:758` / `reconcileConfigDirFiles()` | configDir walk — skips excluded/volatile + hidden (`.`-prefixed) files |
| `sync-manager.ts:1189` (in `determineSyncActions()`) | inline filter | Drops sync actions for excluded paths |
| `sync-manager.ts:1486`, `1539` | `loadMetadata()` / `addConfigDirToMetadata()` | Initial/toggle-enable scans skip excluded files |
| `sync-manager.ts:1641` | `performExcludedMetadataCleanup()` (via `removeExcludedFromMetadata()`) | Settings-triggered reconciliation, see below |

### `isPathSyncable(filePath)` — the settings-toggle-aware superset (`sync-manager.ts:716`)

Added 2026-07-05 (`plan-fix-preview-accuracy-and-delete-visibility.md`). `shouldSkipFile()` alone doesn't know about the `syncConfigDir` toggle (gated separately at `determineSyncActions()`'s tail filter and `reconcileConfigDirFiles()`'s early return) or the configDir dot-file skip (`reconcileConfigDirFiles()`). `isPathSyncable()` layers both on top, in order: manifest always `true` → `shouldSkipFile()` → `syncConfigDir` gate (any configDir path is unsyncable when the toggle is off) → dot-prefixed-basename-under-configDir gate. It's a **strict widening** — every path `shouldSkipFile()` used to catch is still caught. Two consumers:
- `src/settings/tab.ts`'s "Preview pattern matches" button (`showPatternPreview()`) — the accurate, local-only picture of what will/won't sync.
- `sync-manager.ts:744`'s `computeExcludedRemoteOrphans()` (see below) — widened 2026-07-05 (`plan-fix-syncconfigdir-remote-orphans.md`) from `shouldSkipFile()` to `!isPathSyncable()`, so it also catches files orphaned by turning `syncConfigDir` off, not just pattern-excluded ones.

### Settings-triggered metadata cleanup (`removeExcludedFromMetadata`) + remote-orphan cleanup (`computeExcludedRemoteOrphans`)

`removeExcludedFromMetadata()` is called from `src/settings/tab.ts` on every pattern-row edit/delete (debounced 400ms via `scheduleMetadataCleanup()` for typing; immediate on row delete). Guarded by `this.syncing` — skipped if a sync is already in flight; the in-flight promise is tracked in `pendingMetadataCleanup` so `sync()`/`firstSync()` can await it before proceeding. `removeConfigDirFromMetadata()` (called when the `syncConfigDir` toggle is switched off) is the same shape, for configDir files.

`performExcludedMetadataCleanup()` deletes any `metadataStore.data.files` entry whose path (or `localPath` if the file was sanitized for illegal chars) now matches `shouldSkipFile()`. **This only removes the local tracking entry — it never touches the physical local file.** This part of the design is unchanged and intentional (`plan-exclude-patterns.md` Edge Cases table).

**What changed 2026-07-05 (`plan-pattern-settings-ux-and-remote-cleanup.md`, widened by `plan-fix-syncconfigdir-remote-orphans.md`):** previously, a file already synced to GitHub before being excluded (or before `syncConfigDir` was turned off) stayed on the remote repo forever — `filterRemoteMetadataFiles()`/local cleanup stripped it from both metadata sides, `determineSyncActions()` never saw it, and `newTreeFiles` (seeded from the **raw, unfiltered** GitHub tree) carried its blob into every subsequent commit unchanged. `computeExcludedRemoteOrphans()` (`sync-manager.ts:744`) now closes this: inside `syncImpl()`, it scans the raw remote tree for any path (except the manifest) where `!isPathSyncable(path)` is true, and emits a `delete_remote` action for each — reusing the existing `delete_remote` pipeline, so the file is actually removed from GitHub on the **next regular sync** (not immediately when the setting changes). `sync()`'s "Sync successful" Notice appends `" (N removed from remote due to exclude patterns)"` when `N > 0` (`sync-manager.ts:446`).

### Settings UI mechanics (`src/settings/tab.ts`, `renderPatternList()`)

Exclude/include lists are each rendered as N rows, each with its own delete (trash) button, plus a trailing **"+ Add pattern"** button (added 2026-07-05, `plan-pattern-settings-ux-and-remote-cleanup.md`). Every keystroke in any row calls `this.plugin.saveSettings()` immediately, then `scheduleMetadataCleanup()` (debounced) — typing never rebuilds the settings tab or steals focus. Clicking "+ Add pattern" pushes one blank row and calls `this.display()` (a full `containerEl.empty()` + rebuild) — safe since it's an explicit click, not a keystroke. There are two independent buttons, one per list (Exclusions, Inclusions).

A **"Preview pattern matches"** button (same date) triggers `showPatternPreview()`: walks the vault root via `collectVaultPaths()` (same recursive `vault.adapter.list()` stack-walk shape as `reconcileConfigDirFiles()`), buckets every path via the pure function `bucketPathsByPattern(paths, isPathSyncable)` in `tab.ts:19`, and opens a `PatternPreviewModal` (`tab.ts:35`) listing "Will sync" / "Excluded by pattern". Local-only — no GitHub API call.

## Known Gaps / TODOs in Code

- **Mobile-illegal filenames abort the whole sync**: `downloadFile()` (`sync-manager.ts:1226`) writes via `vault.adapter.writeBinary(normalizedPath, ...)` with no filename sanitization. If a remote file's name contains a character the mobile OS filesystem rejects (e.g. `>` `<` `:` `"` `|` `?` `*` — legal on macOS/Linux, so the file can be created on desktop and pushed to GitHub), the mobile adapter throws `FILE_NOTCREATED` and the error propagates out of `syncImpl()` (caught at `sync-manager.ts:413`), aborting the entire sync before `commitSync()` runs. No sanitization or skip-and-continue exists anywhere in `src/`. Observed 2026-06-17 on a download of `Books/Multibagger Cara Meraih Profit >100% dari Pasar Saham.md`.
- **CRITICAL BUG (Conflict Handling)**: In `syncImpl()`, when `conflictHandling` is `overwriteLocal` or `overwriteRemote`, `conflictActions` is populated by mapping over `conflictResolutions` instead of `conflicts`. Because `conflictResolutions` is empty in those branches, the conflict is ignored, falls through to `determineSyncActions`, and is incorrectly treated as an `upload` action (overwriting remote regardless of setting).
- `commitSync`: TODO comment about not reverting SHA updates on sync failure
- `determineSyncActions`: TODO in remote-deleted/local-missing case about removing remote reference
- `isSyncable()` in `EventsListener` has an edge case: all non-configDir files pass even if outside vault root (not reachable in practice via Obsidian events)
- `reconcileConfigDirFiles()` not called in `firstSyncImpl()` path — if user installs plugin after startup but before first sync, `firstSyncFromLocal()` may miss those files (rare; files installed before startup are caught by `loadMetadata()` at startup)
- `PatternPreviewModal.onOpen()` (the rendered "Will sync"/"Excluded" list markup in the Preview modal) has no test coverage — verified via typecheck + production build only, same class of Obsidian-DOM gap as `tab.ts`'s `display()`. The logic feeding it (`bucketPathsByPattern()`, `collectVaultPaths()`) is unit-tested; only the leaf-level rendering isn't.
- `computeExcludedRemoteOrphans()`'s `delete_remote` actions are tested at the point they're produced, not through a full `syncImpl()` integration test — `syncImpl()` itself has no direct test anywhere in this codebase (pre-existing, every sub-piece is tested the same way at its own output boundary).
- Testing `tab.ts`'s `Setting`-heavy methods (`renderPatternList()`, `showPatternPreview()`) requires a local `vi.mock("obsidian", ...)` override inside `tab.test.ts` providing minimal `Setting`/`PluginSettingTab`/`Modal` fakes — the shared `vitest.setup.ts` mock doesn't export `Setting` at all. Any future test touching these methods needs the same local mock pattern (see `tab.test.ts` top of file).

## Update 2026-07-04

### Sync Notices (all `Notice()` call sites)

| Site | Message | When shown |
|---|---|---|
| `main.ts:184` | `"Sync plugin not configured"` | required settings (`githubToken`/`Owner`/`Repo`/`Branch`) empty |
| `main.ts:188` | `"Syncing..."` | first-sync path only, before `firstSync()` starts |
| `main.ts:194` | `"Sync successful"` (5000ms) | first-sync path only, after `firstSync()` resolves without throwing |
| `main.ts:198` | `"Error syncing. {err}"` | first-sync path only, `firstSync()` threw |
| `sync-manager.ts:449` | `"Sync already in progress"` | regular sync, `this.syncing` already true — aborts early, no success/error notice follows |
| `sync-manager.ts:454` | `"Syncing..."` | regular sync path, before `syncImpl()` starts |
| `sync-manager.ts:463` | `"Sync successful"`, or `"Sync successful (N removed from remote due to exclude patterns)"` if `syncImpl()` returned `N > 0` (5000ms) | regular sync path, `syncImpl()` resolved without throwing — added 2026-07-05, `plan-fix-preview-accuracy-and-delete-visibility.md` |
| `sync-manager.ts:472` | `"Error syncing. {err}"` | regular sync path, `syncImpl()` threw |

No `Notice()` call in this codebase carries an icon, emoji, or checkmark prefix — every message above is plain text. There is no settings toggle that mutes/enables notices, and no per-device difference in this logic; `main.ts:167` (`sync()`) is the single entrypoint used by ribbon click, interval timer, window-focus, and window-blur triggers alike (`main.ts:148,154,160,162`).

**Re: "checkmark appears sometimes, not others" report** — no code path in this plugin renders a checkmark glyph on the "Sync successful" Notice. Two real (non-config-sync) sources of the reported inconsistency:
1. `"Sync already in progress"` fires instead of `"Sync successful"` when a second sync trigger (interval timer, window blur/focus, manual ribbon click) lands while `this.syncing` is still `true` from a prior sync — no lock, just a boolean flag (see Concurrency section). This message looks different (no success notice at all), which could read as "missing checkmark".
2. Any perceived checkmark icon is rendered by the OS/Obsidian mobile shell around the toast, not by this plugin's code — plugin only ever passes plain strings to `new Notice(...)`.

`syncConfigDir` (Config Dir Sync section above) has no code path that touches Notice display — ruled out as a cause of notice-text/icon inconsistency.
