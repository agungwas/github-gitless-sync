# Plan: Sync Bug Fixes

## Goal
Fix two critical bugs in `src/sync-manager.ts`:
1. **Background Sync Race Condition**: Prevent data loss when users modify text files concurrently during a background sync. The metadata `sha` should be calculated from the exact content uploaded instead of reading the disk a second time.
2. **Conflict Handling Logic Flaw**: Fix the `conflictHandling` options `overwriteLocal` and `overwriteRemote` to process the actual `conflicts` array instead of the unpopulated `conflictResolutions` array.

Impact analysis: ./IMPACT_sync-bug-fixes.md

## Deviations

> Baseline: clean (13 tests passing)
> Command: `npm run test`
> Final run: 13 tests passing. Command: `npm run test`

| What changed | Why | Update feature doc? |
|---|---|---|

## Implementation Steps

### Step 1: Add `calculateSHAFromString` helper method
**File**: `src/sync-manager.ts`
**Action**: Add a new asynchronous method to the `SyncManager` class that calculates the SHA-1 of a string exactly as git computes blob SHAs (mirroring the logic in `calculateSHA`).
```typescript
  async calculateSHAFromString(content: string): Promise<string> {
    const contentBytes = new TextEncoder().encode(content);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }
```

### Step 2: Update `commitSync` to use `calculateSHAFromString` for text files
**File**: `src/sync-manager.ts`
**Action**: Modify the `commitSync` method where it iterates over `treeFiles`. Currently, it uses `calculateSHA(filePath)` to recalculate the SHA from disk for text files (`hasTextExtension(filePath)`). Replace this with a call to the new `calculateSHAFromString` method using the `content` property of the `treeFiles` item.

**Current:**
```typescript
          if (hasTextExtension(filePath)) {
            const sha = await this.calculateSHA(filePath);
            if (this.metadataStore.data.files[filePath]) {
```

**New:**
```typescript
          if (hasTextExtension(filePath)) {
            const sha = await this.calculateSHAFromString(treeFiles[filePath].content as string);
            if (this.metadataStore.data.files[filePath]) {
```

### Step 3: Fix `conflictHandling` mapping
**File**: `src/sync-manager.ts`
**Action**: Inside `syncImpl()`, locate the `if (conflicts.length > 0)` block where conflict resolutions are generated. For the `overwriteLocal` and `overwriteRemote` branches, change `conflictResolutions.map` to `conflicts.map` and correctly type the lambda argument as `ConflictFile`.

**Current:**
```typescript
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "download", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      }
```

**New:**
```typescript
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        conflictActions = conflicts.map(
          (conflict: ConflictFile) => {
            return { type: "download", filePath: conflict.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        conflictActions = conflicts.map(
          (conflict: ConflictFile) => {
            return { type: "upload", filePath: conflict.filePath };
          },
        );
      }
```

## Open Questions
None. The root cause of the data loss has been isolated to these specific lines, and the resolution is straightforward.
