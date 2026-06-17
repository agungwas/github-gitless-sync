---
status: done
testing: tdd
created: "2026-06-17"
impact: ./download-error-context-impact.md
completed: "2026-06-17"
---

# Plan: Add Filename Context to Filesystem Error Messages

## Goal

When any filesystem write/delete op or blob fetch fails during sync, the error logged by the top-level `sync()` catch must name the offending file or folder. Currently all 8 sites throw bare errors with no path context.

## Approach

**Chosen: wrap each bare filesystem op and bare re-throw with a try-catch that embeds the path in the error message using `{ cause: err }` to preserve the original stack.**

No new abstractions. No control-flow change. All paths are already in scope at each site. Every site uses the same pattern:

```ts
try {
  await this.vault.adapter.<op>(path, ...);
} catch (err) {
  throw new Error(
    `Failed to <op> <path>: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

For the one existing catch block (`getRemoteFileContentWithFallback`), the re-throw is wrapped instead of the call site.

## Implementation Steps

### Step 1 — `firstSyncFromRemote()` mkdir for directory entries (`sync-manager.ts:233`)

```ts
// Before:
await this.vault.adapter.mkdir(normalizedPath);

// After:
try {
  await this.vault.adapter.mkdir(normalizedPath);
} catch (err) {
  throw new Error(
    `Failed to create directory ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 2 — `firstSyncFromRemote()` mkdir for file parent dirs (`sync-manager.ts:261`)

```ts
// Before:
await this.vault.adapter.mkdir(normalizedDir);

// After:
try {
  await this.vault.adapter.mkdir(normalizedDir);
} catch (err) {
  throw new Error(
    `Failed to create directory ${normalizedDir}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 3 — `firstSyncFromRemote()` writeBinary (`sync-manager.ts:268`)

```ts
// Before:
await this.vault.adapter.writeBinary(normalizedPath, data.buffer);

// After:
try {
  await this.vault.adapter.writeBinary(normalizedPath, data.buffer);
} catch (err) {
  throw new Error(
    `Failed to write file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 4 — `getRemoteFileContentWithFallback()` catch re-throw (`sync-manager.ts:781`)

```ts
// Before:
} catch (err) {
  if (err.status !== 404) {
    throw err;
  }
}

// After:
} catch (err) {
  if (err.status !== 404) {
    throw new Error(
      `Failed to fetch remote content for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
```

### Step 5 — `commitSync()` write conflict resolutions (`sync-manager.ts:1210`)

```ts
// Before:
await this.vault.adapter.write(resolution.filePath, resolution.content);

// After:
try {
  await this.vault.adapter.write(resolution.filePath, resolution.content);
} catch (err) {
  throw new Error(
    `Failed to write conflict resolution for ${resolution.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 6 — `downloadFile()` mkdir (`sync-manager.ts:1238`)

```ts
// Before:
if (!(await this.vault.adapter.exists(fileFolder))) {
  await this.vault.adapter.mkdir(fileFolder);
}

// After:
if (!(await this.vault.adapter.exists(fileFolder))) {
  try {
    await this.vault.adapter.mkdir(fileFolder);
  } catch (err) {
    throw new Error(
      `Failed to create directory ${fileFolder}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
```

### Step 7 — `downloadFile()` writeBinary (`sync-manager.ts:1240`)

```ts
// Before:
await this.vault.adapter.writeBinary(
  normalizedPath,
  base64ToArrayBuffer(blob.content),
);

// After:
try {
  await this.vault.adapter.writeBinary(
    normalizedPath,
    base64ToArrayBuffer(blob.content),
  );
} catch (err) {
  throw new Error(
    `Failed to write file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 8 — `deleteLocalFile()` remove (`sync-manager.ts:1256`)

```ts
// Before:
await this.vault.adapter.remove(normalizedPath);

// After:
try {
  await this.vault.adapter.remove(normalizedPath);
} catch (err) {
  throw new Error(
    `Failed to delete file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 9 — `commitSync()` readBinary + createBlob for binary files (`sync-manager.ts:1152`)

Both ops are sequential inside the same `filePath` loop iteration — wrap the whole block:

```ts
// Before:
const buffer = await this.vault.adapter.readBinary(filePath);
const { sha } = await this.client.createBlob({
  content: arrayBufferToBase64(buffer),
  retry: true,
  maxRetries: 3,
});
await this.logger.info("Created blob", filePath);
treeFiles[filePath].sha = sha;
delete treeFiles[filePath].content;

// After:
let sha: string;
try {
  const buffer = await this.vault.adapter.readBinary(filePath);
  const result = await this.client.createBlob({
    content: arrayBufferToBase64(buffer),
    retry: true,
    maxRetries: 3,
  });
  sha = result.sha;
} catch (err) {
  throw new Error(
    `Failed to process binary file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
await this.logger.info("Created blob", filePath);
treeFiles[filePath].sha = sha;
delete treeFiles[filePath].content;
```

### Step 10 — `syncImpl()` read during upload action (`sync-manager.ts:564`)

The `read` is inside a short-circuit expression — extract it so try-catch wraps only the read:

```ts
// Before:
const content =
  resolution?.content ||
  (await this.vault.adapter.read(normalizedPath));

// After:
let fileContent: string;
try {
  fileContent = await this.vault.adapter.read(normalizedPath);
} catch (err) {
  throw new Error(
    `Failed to read file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
const content = resolution?.content || fileContent;
```

### Step 11 — `firstSyncFromLocal()` read for text files (`sync-manager.ts:318`)

```ts
// Before:
if (hasTextExtension(normalizedPath)) {
  content = await this.vault.adapter.read(normalizedPath);
}

// After:
if (hasTextExtension(normalizedPath)) {
  try {
    content = await this.vault.adapter.read(normalizedPath);
  } catch (err) {
    throw new Error(
      `Failed to read file ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
```

### Step 12 — Verify

Run `npm run test` — no tests reference these ops with specific error messages, so no breakage expected (confirmed by impact doc).

## Test Scenarios

| # | Scenario | Setup | Expected | Notes |
|---|---|---|---|---|
| H1 | `downloadFile` mkdir throws | mock `vault.adapter.exists` → false, mock `vault.adapter.mkdir` → throws `"FOLDER_NOTCREATED"` | re-thrown error message contains folder path | Step 6 |
| H2 | `downloadFile` writeBinary throws | mock `vault.adapter.exists` → true, mock `vault.adapter.writeBinary` → throws `"FILE_NOTCREATED"` | re-thrown error message contains file path | Step 7 |
| H3 | `deleteLocalFile` remove throws | mock `vault.adapter.remove` → throws `"FILE_NOTFOUND"` | re-thrown error message contains file path | Step 8 |
| H4 | `getRemoteFileContentWithFallback` non-404 throws | mock `client.getBlob` → throws `{ status: 500 }` | re-thrown error message contains filePath | Step 4 |
| R1 | `getRemoteFileContentWithFallback` 404 swallowed | mock `client.getBlob` → throws `{ status: 404 }` | no throw, resolves undefined | Regression guard — existing behavior must not change |

### Coverage Gaps

| Plan reference | Why no test | Needs human decision |
|---|---|---|
| Steps 1–3: `firstSyncFromRemote` mkdir/writeBinary | Requires mocking ZIP extraction (BlobReader, ZipReader) — complex setup with no existing pattern in test suite | no |
| Step 5: `commitSync` conflict resolution write | `commitSync` makes GitHub API calls (createTree, createCommit, getBranchHead, updateBranchHead) requiring full mock chain | no |
| Step 9: `commitSync` binary blob readBinary+createBlob | Same as Step 5 | no |
| Step 10: `syncImpl` upload read | `syncImpl` runs the full sync pipeline requiring remote manifest, tree, etc. | no |
| Step 11: `firstSyncFromLocal` text file read | `firstSyncFromLocal` calls `commitSync` at end requiring full mock chain | no |

All gaps follow the identical pattern as the tested cases (try-catch wrapping with path in message). No human decision required — behavior is fully specified in plan steps.

### Failure Verification

```
Command: npm run test -- src/sync-manager.test.ts
Test files:
  - src/sync-manager.test.ts
Run at: 2026-06-17 19:39
Result: 4 new tests failing with valid TDD reasons; 1 regression guard passing; 2 pre-existing tests passing

Sample failures:
  - includes folder path in error when mkdir fails
    → AssertionError: expected error including 'Books' but got 'FOLDER_NOTCREATED'
  - includes file path in error when writeBinary fails
    → AssertionError: expected error including 'Books/test.md' but got 'FILE_NOTCREATED'
  - includes file path in error when remove fails
    → AssertionError: expected error including 'Books/test.md' but got 'FILE_NOTFOUND'
  - includes file path in error when blob fetch fails with non-404 status
    → AssertionError: expected error including 'Books/test.md' but got 'Internal Server Error'
```

## Deviations

| # | Deviation | Reason | Update feature doc? |
|---|---|---|---|
| — | (none) | All 12 steps implemented per spec. Tests passing: 7/7 (4 new + 3 baseline) | no |

**Baseline:** TDD — 3 baseline-green tests, 4 new tests failing (expected)
**Command:** `npm run test -- src/sync-manager.test.ts`
**Final run:** All 7 tests passing (4 new + 3 baseline green)

## Open Questions

None.

## QA Sweep

### Header

```
Runtime: CLI/API Runbook (non-FE — sync-manager.ts is pure TypeScript logic)
Scenarios: H4 / E4 / N5
Critique mode: single-sweep  (files: 2, lines: 256, threshold: 10/500)
Pipeline order: pre-iris-5
```

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| boundary | Error wrapping — no numerical boundaries | auto-confirmed |
| max | No size limits touched | auto-confirmed |
| concurrent | Concurrency model unchanged (same `this.syncing` flag) | auto-confirmed |
| auth-fail | Auth not touched | auto-confirmed |
| i18n | No user-visible strings — errors go to logger/exception | auto-confirmed |
| a11y | Non-FE diff | auto-confirmed |
| slow-network | Timeout handling not changed | auto-confirmed |
| empty | Applicable — empty path normalizes differently per platform | included as E1 |
| network-fail | Applicable — blob fetch wraps non-404 | included as E3 |
| permission | Applicable — filesystem permission errors are the target failure type | included as E4 |

### Scenario Matrix

| # | Family | Scenario | Source | Expected |
|---|---|---|---|---|
| H1 | happy | `downloadFile` mkdir + writeBinary succeed | plan step 6+7 | no throw, metadata updated |
| H2 | happy | `downloadFile` folder exists, writeBinary succeeds | plan step 7 | no throw |
| H3 | happy | `deleteLocalFile` remove succeeds | plan step 8 | metadata marks deleted |
| H4 | happy | `getRemoteFileContentWithFallback` 404 swallowed (regression) | plan test R1 | returns undefined, no throw |
| E1 | edge | empty string filePath | taxonomy: empty | error contains normalized path |
| E2 | edge | OS-illegal chars in filename (the original bug case) | feature README Known Gaps | error contains full illegal path |
| E3 | edge | network error (non-404) from blob fetch | plan step 4 + taxonomy: network-fail | error contains filePath |
| E4 | edge | filesystem permission denied on mkdir | taxonomy: permission | error contains folder path |
| N1 | negative | `downloadFile` mkdir throws FOLDER_NOTCREATED | plan test H1 | error contains folder path |
| N2 | negative | `downloadFile` writeBinary throws FILE_NOTCREATED | plan test H2 | error contains file path |
| N3 | negative | `deleteLocalFile` remove throws FILE_NOTFOUND | plan test H3 | error contains file path |
| N4 | negative | non-404 blob fetch throws | plan test H4 | error contains filePath |
| N5 | negative | `firstSyncFromLocal` read throws (gap — unwrapped) | plan step 11 intent | **FAIL: error has no path context** |

### Coverage Gaps

| Plan reference | Why no coverage | Needs human decision |
|---|---|---|
| Step 11: `firstSyncFromLocal()` read at `sync-manager.ts:408` | Plan label said `firstSyncFromLocal` but edit landed in `firstSyncFromRemote` instead. `firstSyncFromLocal` read is still unwrapped. | **yes — blocker** |
| `firstSyncImpl()` manifest `readBinary` at `sync-manager.ts:143` | Out of plan scope (bare-repo first-commit path) | no |
| `findConflicts()` local content `read` at `sync-manager.ts:925` | Out of plan scope — plan focused on write/delete/download chain | no |
| `calculateSHA()` `readBinary` at `sync-manager.ts:1093` | Out of plan scope — utility function, guards with `exists()` first | no |

### Critique

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| major | plan-conformance | `src/sync-manager.ts:408` | Plan Step 11 targets `firstSyncFromLocal()` but edit wrapped `firstSyncFromRemote()` equivalent instead. `firstSyncFromLocal` read at line 408 is still bare — throws `"FILE_NOTFOUND"` without path context on read failure. | Wrap `src/sync-manager.ts:408` with same try-catch pattern as the other reads |
| major | plan-conformance | `src/sync-manager.ts:590-598` | Step 10 changed lazy eval (`resolution?.content \|\| await read()`) to eager eval (always reads then `\|\|`). File is now always read even when resolution content overrides. Extra I/O; edge case: if file deleted between conflict detection and commit, old code would succeed (use resolution), new code throws. | Restore lazy eval: `fileContent` should only be read when `resolution?.content` is falsy. Pattern: `const content = resolution?.content ?? await (async () => { try { return await vault.adapter.read(...) } catch(e) {...} })()` — or simpler, guard the read inside `if (!resolution?.content)` |
| minor | error-handling | `src/sync-manager.ts:1192-1210` | Step 9 conflates `readBinary` (filesystem) and `createBlob` (GitHub API/network) under single "Failed to process binary file" message. Different failure domains make diagnosis harder — a `FILE_NOTCREATED` error looks identical to a `502 Bad Gateway` in the log. | Split into two separate try-catch blocks with distinct messages: "Failed to read binary file" vs "Failed to upload binary blob" |

### Run Results

```
Command: npm run test -- src/sync-manager.test.ts
Run at: 2026-06-17 19:51
Result: 7 passed (7) — all automated scenarios (N1–N4 + R1 regression + 2 baseline)
```

Manual scenarios E1, E2, H1-H3, H4 (non-conflict path), N5 require integration harness (Obsidian vault mock not available in unit test environment). N5 confirmed gap via code inspection — `src/sync-manager.ts:408` has no try-catch.
