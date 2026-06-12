# Impact Analysis: Rename Plugin to Fork Identity

## Goal

Change the plugin's identity so Obsidian treats it as a separate plugin from the upstream
`github-gitless-sync`. Upstream community plugin updates will no longer overwrite this fork.

Implementation steps: N/A — analysis only.

---

## What Constitutes Plugin Identity in Obsidian

Obsidian identifies a plugin by its **`id`** field in `manifest.json`. Everything flows from that:

| Identity artifact | Current value | Runtime significance |
|---|---|---|
| `manifest.json` → `id` | `github-gitless-sync` | **THE canonical identifier.** Determines install path, data path, community update matching |
| `manifest.json` → `name` | `GitHub Gitless Sync` | Display name in Obsidian settings UI |
| `manifest-beta.json` → `id` + `name` | same | Beta channel equivalent |
| `package.json` → `name` | `github-gitless-sync` | Build tooling only, no runtime effect |
| `DEVICE_NAME_STORAGE_KEY` in `src/sync-manager.ts:46` | `"github-gitless-sync-device-name"` | localStorage key; if changed, existing device name lost |
| `MANIFEST_FILE_NAME` in `src/metadata-store.ts:3` | `"github-sync-metadata.json"` | Sync state file in vault configDir — **not plugin-ID-derived** |
| `LOG_FILE_NAME` in `src/logger.ts:3` | `"github-sync.log"` | Log file in vault configDir — **not plugin-ID-derived** |
| TypeScript class names (`GitHubSyncPlugin`, `GitHubSyncSettings`, etc.) | various | Internal only — compiled away by esbuild, zero runtime effect |

---

## Impact Analysis

| Area | Impact | Risk |
|---|---|---|
| **Obsidian install path** `{configDir}/plugins/{id}/` | After rename, Obsidian installs fork at new path (e.g. `plugins/my-sync/`). Original install at `plugins/github-gitless-sync/` is separate. Neither overwrites the other. This is the desired outcome. | **Low** — this is exactly the goal |
| **`data.json` (plugin settings)** at `{configDir}/plugins/{old-id}/data.json` | `plugin.loadData()` reads from `{configDir}/plugins/{new-id}/data.json`. All current settings (GitHub token, owner, repo, branch, sync strategy, conflict mode, etc.) are at the OLD path and will NOT be found. Plugin starts with `DEFAULT_SETTINGS` — first run behaves as a brand-new install. | **High** — all settings lost without manual migration. User must re-enter GitHub token, repo details, etc. |
| **Sync metadata file** `{configDir}/github-sync-metadata.json` | This filename is hardcoded in `metadata-store.ts:3` — NOT derived from plugin ID. Both original and fork use the same filename. Sync state (all file SHAs, lastSync) is SHARED between the two plugins. | **High** — if BOTH plugins are installed simultaneously, they compete over the same metadata file and the same GitHub repo, causing data corruption. Only one should be active at a time. |
| **Community plugin auto-updates** | Obsidian matches community plugin updates by `id`. Fork with new ID no longer receives upstream updates. User must manually track and cherry-pick upstream changes. | **Low** — this is the desired outcome. Trade-off is intentional. |
| **`DEVICE_NAME_STORAGE_KEY`** `"github-gitless-sync-device-name"` in `src/sync-manager.ts:46` | localStorage key. If key string is kept unchanged after rename, device name from original plugin carries over (transparent to user). If key string is changed to match new plugin name, existing device name is lost and user must re-enter. | **Low** — either choice is safe; data loss is minor (just a display name) |
| **`MANIFEST_FILE_NAME`** `"github-sync-metadata.json"` | Changing this string would rename the sync metadata file. Existing vaults already have the old filename synced to GitHub. Renaming breaks the sync bootstrap — plugin wouldn't find its own manifest on startup. | **High** — do NOT change this value |
| **`LOG_FILE_NAME`** `"github-sync.log"` | Changing creates a new log file, old log abandoned. No sync impact (log is volatile, never synced). | **Low** — safe to change or keep |
| **TypeScript names** (`GitHubSyncPlugin`, `GitHubSyncSettings`, etc.) | No runtime effect. Cosmetic developer-experience change only. | **Low** — completely safe to rename or leave |

---

## Cross-Feature Risks

| Feature / File | Risk | Why |
|---|---|---|
| `src/metadata-store.ts:3` — `MANIFEST_FILE_NAME` | **High** — do not change. `github-sync-metadata.json` is the path written to the remote GitHub repo's tree. Every vault syncing to that repo expects this exact path in the manifest. Changing it creates a new metadata file and the old one becomes an orphan in the remote tree — next sync sees no manifest and throws `"Remote manifest is missing"` error. | Traced: `syncImpl()` reads `files[\`${configDir}/${MANIFEST_FILE_NAME}\`]` at `sync-manager.ts:423`; missing = hard error. |
| `src/sync-manager.ts:46` — `DEVICE_NAME_STORAGE_KEY` | **Low** — if changed, device name in localStorage at old key is orphaned. No sync breakage. User re-enters device name. If unchanged, no impact at all. | Traced: only read in `commitSync()` at `sync-manager.ts:1188` via `localStorage.getItem`. |
| `src/settings/settings.ts` — `DEFAULT_SETTINGS` | **High** — after rename, plugin starts with defaults on first load (no `data.json` at new path). `firstSync: true` default means plugin treats this as a brand-new first sync. If vault already has files and remote already has files (prior sync with original plugin), first sync WILL fail with `"Both remote and local have files, can't sync"`. | Traced: `firstSyncImpl()` at `sync-manager.ts:108` throws on non-empty both sides. |
| `src/logger.ts:3` — `LOG_FILE_NAME` | **None** — log file is volatile, excluded from sync via `isVolatileSyncArtifact()`. Rename or keep, no sync impact. | Traced: `isVolatileSyncArtifact()` at `sync-manager.ts:613` checks for `LOG_FILE_NAME`. |

---

## Edge Cases

| Case | Expected behavior |
|---|---|
| Both original and fork installed simultaneously | Both read/write `github-sync-metadata.json` in the same vault configDir. Both try to sync the same remote repo. Race condition on metadata + multiple commits to same branch. **Data corruption likely.** Original must be disabled or uninstalled before fork is used. |
| Rename done, first sync attempted without migrating `data.json` | Plugin loads `DEFAULT_SETTINGS` → `firstSync: true` → calls `firstSyncImpl()` → vault is non-empty, remote is non-empty → throws `"Both remote and local have files, can't sync"`. User is blocked until settings are re-entered AND `firstSync` is manually set to `false` (or metadata is reset). |
| `data.json` manually copied from old plugin path to new plugin path | Settings restored. `firstSync` flag preserved as `false`. Plugin resumes normal sync without first-sync check. This is the correct migration path. |
| User installs fork from local file (not community plugins) | Works. Obsidian installs from local `manifest.json` + `main.js`. No community registry involved. |
| Original upstream plugin also installed and original updates arrive | Obsidian shows update notification for original plugin only. Fork is unaffected. If user installs the upstream update ON TOP of the fork (same new ID as fork), they overwrite the fork. Avoid naming the fork the same as an existing community plugin. |
| `MANIFEST_FILE_NAME` accidentally changed | Next sync: `syncImpl()` looks for `{configDir}/{newName}` in remote tree → not found → `"Remote manifest is missing"` error. All syncs broken until reverted. |
| `syncConfigDir=true` on the fork | Fork's own `data.json` (at `{configDir}/plugins/{new-id}/data.json`) is synced to GitHub. This exposes the GitHub token on public repos — same warning as original plugin. Also: if original plugin's `data.json` is at a different path and `syncConfigDir=true`, both data files are synced. |
