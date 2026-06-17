# Plan: Rename Plugin to Gitless

## Goal

Rename fork identity from `github-gitless-sync` to `gitless` so Obsidian treats it
as a separate plugin. Upstream community plugin updates will no longer overwrite this fork.

## Impact Analysis

Reference: [./IMPACT_plugin-rename-fork.md](./IMPACT_plugin-rename-fork.md)

Affected feature docs to update after implementation: `sync` (`features/sync.md`)
(only the `DEVICE_NAME_STORAGE_KEY` value changes)

## Design Rationale

Minimum viable rename: only change what Obsidian uses to identify the plugin and
what the code uses to key localStorage. Internal TypeScript names (`GitHubSyncPlugin`,
`GitHubSyncSettings`, etc.) are compiled away by esbuild — renaming them is cosmetic
noise with no runtime value.

`MANIFEST_FILE_NAME` and `LOG_FILE_NAME` are NOT changed — they are filenames inside
the vault configDir and the remote GitHub repo tree. Renaming either would orphan
the existing sync metadata.

## Implementation Steps

Files changed: `manifest.json`, `manifest-beta.json`, `package.json`, `src/sync-manager.ts`.

---

### Step 1 — Update `manifest.json`

File: `manifest.json` (project root)

Change:
```json
"id": "github-gitless-sync",
"name": "GitHub Gitless Sync",
```

To:
```json
"id": "gitless",
"name": "Gitless",
```

Leave all other fields unchanged (`version`, `minAppVersion`, `description`, `author`,
`authorUrl`, `fundingUrl`, `isDesktopOnly`).

---

### Step 2 — Update `manifest-beta.json`

File: `manifest-beta.json` (project root)

Apply same changes as Step 1:
```json
"id": "gitless",
"name": "Gitless",
```

---

### Step 3 — Update `package.json`

File: `package.json` (project root)

Change:
```json
"name": "github-gitless-sync",
```

To:
```json
"name": "gitless",
```

Build tooling only — no runtime effect.

---

### Step 4 — Update `DEVICE_NAME_STORAGE_KEY` in `src/sync-manager.ts`

File: `src/sync-manager.ts`, line 46.

Change:
```typescript
export const DEVICE_NAME_STORAGE_KEY = "github-gitless-sync-device-name" as const;
```

To:
```typescript
export const DEVICE_NAME_STORAGE_KEY = "gitless-device-name" as const;
```

Effect: device name resets to empty on first use of fork. User re-enters device name
once in settings. Old localStorage key `"github-gitless-sync-device-name"` is orphaned
but harmless.

---

### Step 5 — Post-install: migrate `data.json` (USER ACTION, not code)

This is a manual step the user must perform BEFORE first sync with the fork installed.

Obsidian stores plugin settings at:
- Old path: `{vault}/.obsidian/plugins/github-gitless-sync/data.json`
- New path: `{vault}/.obsidian/plugins/gitless/data.json`

After installing the renamed plugin, copy `data.json` from old path to new path.
This restores GitHub token, owner, repo, branch, and all other settings.

If skipped: plugin loads `DEFAULT_SETTINGS` → `firstSync: true` → first sync
attempt fails with `"Both remote and local have files, can't sync"`.

---

## Open Questions

**Q1 (non-blocking):** Should `author`, `authorUrl`, `fundingUrl` in both manifests
be updated to reflect the fork maintainer instead of original author "Silvano Cerza"?
→ No code impact. Cosmetic — affects display in Obsidian settings only.

**Q2 (non-blocking):** Should `description` in both manifests be updated?
→ Current: `"Sync a GitHub repository with vaults on different platforms without requiring git installation"`
→ No code impact.

## Affected Feature Docs

- `features/sync.md` — remove Device Name section entirely (constant removed, localStorage approach dropped)

## Deviations

Baseline: no test suite exists. Verification via TypeScript compiler only.
Command: `npx tsc --noEmit --skipLibCheck`
Final run: clean — no errors.

| What changed | Why | Update feature doc? |
|---|---|---|
| Step 4 — `DEVICE_NAME_STORAGE_KEY` removed entirely instead of renamed to `"gitless-device-name"` | User decided to drop device name feature before iris-5 ran; device name now embedded directly in commit template string | yes |
