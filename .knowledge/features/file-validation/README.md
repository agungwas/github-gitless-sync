---
iris_schema: 4
last_updated: "2026-06-18"
updated_by_plan: "plan-sanitize-remote-convergence.md"
decision: "2026-06-18 — Converge Illegal-Char Filenames on Remote"
---
# file-validation

## Purpose

Detect and handle file names from the remote GitHub repository that are illegal on the current platform (primarily iOS mobile) before attempting to write them to the local filesystem.

## Problem

GitHub accepts filenames with characters that are illegal on iOS (and Windows). When the sync plugin downloads a file whose name contains such a character, Obsidian's `vault.adapter.writeBinary()` fails with `FILE_NOTCREATED` — an opaque iOS filesystem rejection. The error is thrown inside `downloadFile()` (`src/sync-manager.ts:1319`) and propagates to abort the entire sync.

**Confirmed example from production log:**
```
"Failed to write file Books/Multibagger Cara Meraih Profit >100% dari Pasar Saham.md: FILE_NOTCREATED"
```
The `>` character in the file name is illegal on iOS.

## Illegal Characters by Platform

| Platform | Illegal in filename |
|---|---|
| iOS / macOS | `:` (macOS), NUL (iOS rejects `>`, `<`, `:`, `"`, `\|`, `?`, `*` via APFS) |
| Windows | `< > : " / \ | ? *` |
| Linux | `/` and NUL only |

In practice the iOS filesystem rejects: `>`, `<`, `:`, `"`, `|`, `?`, `*`, `\`.

## Implementation

### Approach

**Unicode fullwidth lookalike substitution & Remote Convergence:** Replace each illegal char with its visually-similar fullwidth equivalent. To avoid divergence, the plugin converges both local disk and GitHub remote to the sanitized unicode lookalike filename.

| Illegal | Lookalike | Codepoint |
|---------|-----------|-----------|
| `>` | `＞` | U+FF1E |
| `<` | `＜` | U+FF1C |
| `:` | `：` | U+FF1A |
| `"` | `＂` | U+FF02 |
| `\|` | `｜` | U+FF5C |
| `?` | `？` | U+FF1F |
| `*` | `＊` | U+FF0A |
| `\` | `＼` | U+FF3C |

Applied per path **segment** (split on `/`), never to path separators. Once a file's name converges, the `localPath` indirection is no longer needed.

### Changes

1. **`src/utils.ts`**: Added `sanitizePathForLocalFilesystem()` + exported `MOBILE_ILLEGAL_CHAR_MAP`.
   Sanitization is O(n) per path, called only at download + first-sync-from-remote (not on hot loop).

2. **`src/metadata-store.ts`**: `FileMetadata` interface now has optional `localPath?: string` field to track sanitized paths when remote filename contains illegal chars.

3. **`src/sync-manager.ts`** — 5 sites updated:
   - `downloadFile()`: Sanitizes path before `writeBinary()`, stores `localPath` when it differs from remote path
   - `firstSyncFromRemote()`: Sanitizes path during ZIP extraction
   - `calculateSHA()`: Resolves file location via `localPath ?? normalizedPath(filePath)`
   - `syncImpl()` upload case: Resolves location for `exists()` and `read()` calls
   - `deleteLocalFile()`: Resolves location for `remove()` call

All sites use `localPath ?? normalizedPath(filePath)` fallback pattern for graceful migration.

### Known Limitations

- **Collision:** Two remote files that sanitize to the same local path (e.g., `foo >.md` and `foo ＞.md` both → `foo ＞.md`) result in the second download overwriting the first. Extremely unlikely in practice; documented as a known limitation.

## Error Surface

| Function | File | Risk |
|---|---|---|
| `downloadFile()` | `src/sync-manager.ts:1319` | High — called for every download action |
| `firstSyncFromRemote()` zip extraction | `src/sync-manager.ts:283` | High — called once on first sync |
| `vault.adapter.writeBinary()` | Obsidian API | Source of `FILE_NOTCREATED` |

## Rename of sanitized files

`EventsListener` has no knowledge of `localPath`. Obsidian fires vault events using the **disk path** (sanitized, e.g. `"foo ＞.md"`), but metadata is keyed by the **remote path** (with illegal chars, e.g. `"foo >.md"`).

### Ghost entry bug (on download)

When `downloadFile()` writes `"foo ＞.md"` to disk, Obsidian fires a `create` event for `"foo ＞.md"`. `onCreate("foo ＞.md")` looks up `metadata["foo ＞.md"]` — undefined (key is `"foo >.md"`). The `justDownloaded` check fails → ghost entry created:
```
metadata["foo ＞.md"] = { sha: null, dirty: true, justDownloaded: false }
```
On next sync: ghost triggers `upload` action → `"foo ＞.md"` (fullwidth name) pushed to GitHub as a new file — **duplicate**.

### Rename path

When user renames `"foo ＞.md"` → `"bar.md"`:
- `onDelete("foo ＞.md")` → finds ghost entry → marks it `deleted: true` ✅
- Real entry `metadata["foo >.md"]` — NOT marked deleted
- Next sync: `calculateSHA("foo >.md")` → `localPath` file gone → null → treated as `delete_remote` (recovery at `sync-manager.ts:576-592`) ✅

Net result: correct, but via indirect recovery path.

### Fix surface

`onCreate` and `onModify` in `events-listener.ts` should reverse-lookup by `localPath` when `metadata[file.path]` is undefined:
```ts
const remoteKey = Object.keys(this.metadataStore.data.files).find(
  k => this.metadataStore.data.files[k].localPath === file.path
) ?? file.path;
```

## Retroactive Migration & Remote Convergence (2026-06-18)

To achieve full remote convergence and clean up legacy unsanitized filenames, the plugin runs a migration scan (`migrateIllegalFilenames`) at the start of every regular sync.

1. **Remote/Local Renames**: Any tracked file with mobile-illegal characters in its path (including folder segments) is renamed locally on the filesystem (if it exists under the old name) and its metadata key is re-keyed to the sanitized version.
2. **Atomic Synchronization**: The old key is soft-tombstoned (`deleted: true`) to trigger a remote deletion (`delete_remote`), while the new sanitized key is queued with `sha: null` to trigger an upload. Both operations are committed atomically in a single sync commit.
3. **Laptop vs. Mobile**:
   - On **laptops/desktops**, the literal `>` file on disk is physically renamed to `＞`.
   - On **mobile devices**, the file is already stored under the sanitized name (`＞`) due to download-time sanitization, so only the local metadata store is re-keyed.
4. **Collision Protection**: If the target sanitized name already exists in local metadata or remote metadata, the migration for that file is skipped and a warning is logged.
5. **Conflict Resolution**: The write path during conflict resolutions in `commitSync` (`src/sync-manager.ts`) uses `localPath` fallback to avoid writing unsanitized files and throwing `FILE_NOTCREATED` on mobile.

## What is NOT the problem

- "Untitled.md" as a filename — valid on all platforms
- GitHub API errors — `FILE_NOTCREATED` is an Obsidian/iOS filesystem error, not a GitHub response
- `normalizePath()` — Obsidian's utility only normalizes path separators, does not sanitize for mobile-illegal chars
