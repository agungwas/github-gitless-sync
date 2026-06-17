---
iris_schema: 4
updated: "2026-06-18"
updated_by_plan: "plan-sanitize-mobile-filenames.md"
decision: "2026-06-18 — Mobile-Illegal Filename Sanitization on Download"
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

**Unicode fullwidth lookalike substitution:** Replace each illegal char with its visually-similar fullwidth equivalent before writing to disk. Metadata key stays as remote path; new optional `localPath` field tracks the actual location on disk.

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

Applied per path **segment** (split on `/`), never to path separators.

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

## What is NOT the problem

- "Untitled.md" as a filename — valid on all platforms
- GitHub API errors — `FILE_NOTCREATED` is an Obsidian/iOS filesystem error, not a GitHub response
- `normalizePath()` — Obsidian's utility only normalizes path separators, does not sanitize for mobile-illegal chars
