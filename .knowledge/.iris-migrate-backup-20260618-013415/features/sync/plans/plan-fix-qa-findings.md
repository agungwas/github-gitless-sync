---
status: done
testing: tdd
created: "2026-06-17"
tests: approved
completed: "2026-06-17"
qa: done
qa_completed: "2026-06-17"
---

# Plan: Fix QA Findings from plan-download-error-context

## Goal

Address all 3 findings surfaced by the iris-4 QA sweep of `plan-download-error-context`:
- F1 (major): `firstSyncFromLocal()` read at `sync-manager.ts:408` still bare — Step 11 of the original plan wrapped the equivalent call in `firstSyncFromRemote` instead
- F2 (major): `syncImpl()` upload path changed from lazy eval to eager eval — file always read even when conflict resolution content overrides it
- F3 (minor): `commitSync()` binary blob block conflates `readBinary` (filesystem) and `createBlob` (network/API) under one catch with "Failed to process binary file" — ambiguous failure domain

## Approach

**Chosen: direct mechanical fixes — same error-wrapping pattern already established in `plan-download-error-context`.**

No new abstractions. No control-flow change beyond restoring original lazy eval in F2. All fixes are ≤10 lines each. Rejected "do nothing": F1 leaves a real gap (one of 8 target sites unwrapped), F2 introduces unnecessary I/O and an edge-case regression.

## Implementation Steps

### Step 1 — Fix F1: `firstSyncFromLocal()` read at `sync-manager.ts:408`

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

### Step 2 — Fix F2: Restore lazy eval in `syncImpl()` at `sync-manager.ts:590`

```ts
// Before (current eager — always reads):
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

// After (lazy — only reads if no resolution content):
let content: string;
if (resolution?.content) {
  content = resolution.content;
} else {
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

### Step 3 — Fix F3: Split `commitSync()` binary blob try-catch at `sync-manager.ts:1190`

```ts
// Before (single block, ambiguous domain):
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

// After (split by failure domain):
let buffer: ArrayBuffer;
try {
  buffer = await this.vault.adapter.readBinary(filePath);
} catch (err) {
  throw new Error(
    `Failed to read binary file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
let sha: string;
try {
  const result = await this.client.createBlob({
    content: arrayBufferToBase64(buffer),
    retry: true,
    maxRetries: 3,
  });
  sha = result.sha;
} catch (err) {
  throw new Error(
    `Failed to upload binary blob for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}
```

### Step 4 — Verify

Run `npm run test` — all tests including new ones from this plan must pass.

## Test Scenarios

| # | Scenario | Setup | Expected | Notes |
|---|---|---|---|---|
| F1 | `firstSyncFromLocal` read throws | mock `metadataStore.data.files` with one text `.md` file, mock `vault.adapter.read` → throws `"FILE_NOTFOUND"` | re-thrown error message contains file path | Step 1 |
| F2 | `syncImpl` upload skips read when resolution content present | mock `vault.adapter.read` → throws, call upload path with `resolution.content` set | no throw — resolution content used without reading disk | Step 2 |
| F3a | `commitSync` readBinary throws | binary file in treeFiles, mock `vault.adapter.readBinary` → throws `"FILE_NOTCREATED"` | error says "Failed to read binary file" (not "process") | Step 3 |
| F3b | `commitSync` createBlob throws | binary file in treeFiles, mock `vault.adapter.readBinary` → resolves, mock `client.createBlob` → throws | error says "Failed to upload binary blob" (not "process") | Step 3 |

### Failure Verification

```
Command: npm run test -- src/sync-manager.test.ts
Test files:
  - src/sync-manager.test.ts
Run at: 2026-06-17 20:07
Result: 3 new tests failing with valid TDD reasons; 7 baseline tests passing

Sample failures:
  - includes file path in error when read fails
    → AssertionError: expected error including 'Books/test.md' but got 'FILE_NOTFOUND'
  - says "Failed to read binary file" when readBinary throws
    → AssertionError: expected error including 'Failed to read binary file' but got 'Failed to process binary file images/photo.png: FILE_NOTCREATED'
  - says "Failed to upload binary blob" when createBlob throws
    → AssertionError: expected error including 'Failed to upload binary blob' but got 'Failed to process binary file images/photo.png: ...'
```

### Coverage Gaps

| Plan reference | Why no test | Needs human decision |
|---|---|---|
| F2 `syncImpl` lazy eval (test F2) | `syncImpl` requires full mock chain (getRepoContent, manifest blob, findConflicts, determineSyncActions) to reach upload path — test complexity disproportionate to fix size | no |

## Deviations

| # | Deviation | Reason | Update feature doc? |
|---|---|---|---|
| — | (none) | All 3 steps implemented per spec. 10/10 tests passing (3 new + 7 baseline). Build clean. | no |

**Baseline:** 3 new tests failing (expected), 7 baseline green.
**Command:** `npm run test -- src/sync-manager.test.ts`
**Final run:** 27/27 full suite passing. Build: clean.

## Open Questions

None.

## QA Sweep

### Header

```
Runtime: CLI/API Runbook (non-FE — sync-manager.ts pure TypeScript logic)
Scenarios: H4 / E4 / N3
Critique mode: single-sweep  (files: 2, lines: ~250, threshold: 10/500)
Pipeline order: pre-iris-5
```

### Taxonomy N/A

| Entry | Reason | Confirm? |
|---|---|---|
| boundary | Error wrapping — no numerical boundaries | auto-confirmed |
| max | No size limits touched | auto-confirmed |
| concurrent | Concurrency model unchanged | auto-confirmed |
| auth-fail | Auth not touched | auto-confirmed |
| i18n | No user-visible strings | auto-confirmed |
| a11y | Non-FE diff | auto-confirmed |
| slow-network | Timeout handling not changed | auto-confirmed |
| empty | Applicable — `resolution.content = ""` (falsy) falls through to disk read | included as E1 |
| network-fail | Applicable — createBlob is network call (F3) | included as E3 |
| permission | Applicable — filesystem read/write errors are target | included as N1 |

### Scenario Matrix

| # | Family | Scenario | Source | Expected |
|---|---|---|---|---|
| H1 | happy | `firstSyncFromLocal` read succeeds | plan step 1 | no error, file content in tree |
| H2 | happy | `syncImpl` upload uses resolution content; disk not read | plan step 2 | resolution content used, `vault.adapter.read` not called |
| H3 | happy | `syncImpl` upload reads disk when no resolution | plan step 2 (null path) | disk content used |
| H4 | happy | `commitSync` readBinary + createBlob both succeed | plan step 3 | sha set, tree updated |
| E1 | edge | `resolution.content = ""` (falsy) in lazy eval | taxonomy: empty | falls through to disk read (pre-existing behavior, consistent with original) |
| E2 | edge | `firstSyncFromLocal` text file at root (no dir separator) | plan step 1 | error contains filename if read fails |
| E3 | edge | createBlob fails after readBinary succeeds | plan step 3 + taxonomy: network-fail | error says "Failed to upload binary blob for {path}" |
| E4 | edge | readBinary fails in commitSync | plan step 3 + taxonomy: permission | error says "Failed to read binary file {path}" |
| N1 | negative | `firstSyncFromLocal` read throws FILE_NOTFOUND | plan step 1 | error contains file path |
| N2 | negative | readBinary throws in commitSync | plan step 3 | error says "Failed to read binary file" |
| N3 | negative | createBlob throws in commitSync | plan step 3 | error says "Failed to upload binary blob" |

### Coverage Gaps

| Plan reference | Why no test | Needs human decision |
|---|---|---|
| H2: syncImpl lazy eval — resolution content used without disk read | Full syncImpl mock chain required (getRepoContent, manifest, findConflicts, determineSyncActions) | no — waived in iris-2 |

### Critique

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| nit | plan-conformance | `src/sync-manager.ts:597` | F2 uses `if (resolution?.content)` truthy guard — empty string `""` resolution (valid: user empties a file) falls through to disk read instead of using resolution. Pre-existing same behavior in original `\|\|` form; not a regression, but worth noting | Use `if (resolution?.content !== undefined)` or `if (resolution != null)` to guard against empty-string edge case |

### Run Results

```
Command: npm run test -- src/sync-manager.test.ts
Run at: 2026-06-17 20:17
Result: 10/10 passing (3 new + 7 baseline)
H1/E4/E3/N1/N2/N3 covered by automated tests. H2/E1/E2 manual-only.
```
