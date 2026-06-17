---
---
# Impact Analysis: Sync Bug Fixes

## Goal
Fix two critical bugs in `sync-manager.ts`:
1. **Background Sync Race Condition**: Prevent data loss when users modify text files concurrently during a background sync. The fix ensures that the local metadata SHA is calculated from the exact content uploaded to GitHub, rather than reading the potentially newer disk state.
2. **Conflict Handling Logic Flaw**: Fix the `conflictHandling` settings (`overwriteLocal` and `overwriteRemote`) to correctly process the `conflicts` array instead of the empty `conflictResolutions` array.

## Impact Analysis

### 1. Background Sync Race Condition
**Affected Code Path**:
- `src/sync-manager.ts` -> `commitSync()`
- `src/sync-manager.ts` -> `calculateSHAFromString()` (new helper method)

**Analysis**:
Currently, `syncImpl()` reads file contents for upload (`vault.adapter.read()`) and later `commitSync()` reads the file from disk again (`calculateSHA(filePath)`) to store the sync metadata. The fix will replace the disk read in `commitSync()` with an in-memory SHA computation (`calculateSHAFromString`) using the exact `treeFiles[filePath].content` that was just pushed to GitHub.
- **Data Integrity**: This guarantees that the `sha` recorded in `github-sync-metadata.json` perfectly matches the blob SHA created by GitHub for the uploaded string.
- **Performance**: This reduces the number of disk reads during `commitSync()` since text files will no longer be read twice.
- **Binary Files**: Unaffected. Binary files are already handled securely in `commitSync()` by uploading the binary blob directly and using the returned SHA from GitHub.

**Risk Level**: **Low**. Computing the SHA from the string guarantees consistency with GitHub's tree blob creation API.

### 2. Conflict Handling Bug
**Affected Code Path**:
- `src/sync-manager.ts` -> `syncImpl()` -> `conflictHandling` blocks

**Analysis**:
Currently, when the setting is `overwriteLocal` or `overwriteRemote`, the code maps over `conflictResolutions` (which is always empty unless the user manually resolves conflicts in the `ask` setting). The fix will map over the `conflicts` array instead.
- **Behavior Change**: Files that are in conflict will now actually be downloaded (`overwriteLocal`) or uploaded (`overwriteRemote`) as intended by the user's settings. Previously, they fell through to `determineSyncActions` which treated them as standard uploads, resulting in a silent "Always Overwrite Remote" behavior regardless of the setting.
- **Dependents**: `determineSyncActions` receives the `conflictFiles` paths and correctly ignores them, allowing `conflictActions` to handle the sync operations natively.

**Risk Level**: **Low**. This strictly enforces the intended behavior matching the user's selected plugin setting.

## Cross-Feature Risks
- **`src/github/client.ts` (`createTree`)**: No risk. The API call continues to receive the same string `content` as before.
- **`src/events-listener.ts`**: No risk. File watcher events are independent of the SHA computation during sync.

## Edge Cases
- **Large Text Files**: Computing the SHA-1 of a large string via `crypto.subtle.digest` in memory is very fast and should not block the main thread significantly.
- **Encoding Differences**: `TextEncoder().encode(content)` produces UTF-8 bytes. GitHub API `createTree` implicitly assumes UTF-8 for string content. Thus, the computed SHA will match GitHub's blob SHA exactly.

## Implementation Steps
N/A — analysis only
