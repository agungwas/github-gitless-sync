# QA Runbook — plan-download-error-context

Non-FE runbook. All scenarios exercise `SyncManager` methods directly via unit tests or by reading error output.

## H1 — downloadFile mkdir succeeds

```ts
// Mock: vault.adapter.exists → false, vault.adapter.mkdir → resolves
// Mock: vault.adapter.writeBinary → resolves
// Mock: client.getBlob → resolves with valid content
const file = { path: "Books/test.md", sha: "abc" };
await syncManager.downloadFile(file, Date.now());
// Expect: no throw, metadataStore updated
```
**Expected:** completes without throw, `metadataStore.data.files["Books/test.md"]` set.

## H2 — downloadFile writeBinary succeeds (folder exists)

```ts
// Mock: vault.adapter.exists → true (skip mkdir)
// Mock: vault.adapter.writeBinary → resolves
await syncManager.downloadFile(file, Date.now());
// Expect: no throw
```

## H3 — deleteLocalFile remove succeeds

```ts
// Mock: vault.adapter.remove → resolves
await syncManager.deleteLocalFile("Books/test.md");
// Expect: metadata marks file deleted
```

## H4 — getRemoteFileContentWithFallback 404 swallowed

```ts
// Mock: client.getBlob → throws { status: 404 }
const result = await syncManager["getRemoteFileContentWithFallback"](...);
// Expect: returns undefined (no throw)
```

## E1 — empty string filePath

```ts
// Path "" normalizes to "/" or "." — Obsidian behavior
await syncManager.downloadFile({ path: "", sha: "abc" }, Date.now());
// Expect: normalized path in any error thrown
```

## E2 — path with OS-illegal chars (the original bug)

```ts
const file = { path: 'Books/Multibagger >100%.md', sha: 'abc' };
// Mock: writeBinary → throws "FILE_NOTCREATED"
await expect(syncManager.downloadFile(file, Date.now())).rejects.toThrow('Books/Multibagger >100%.md');
// Expect: error contains the full path including illegal chars
```

## E3 — network error (non-404) from blob fetch

```ts
// Mock: client.getBlob → throws { status: 500, message: "Internal Server Error" }
await expect(syncManager["getRemoteFileContentWithFallback"]("Books/test.md", ...)).rejects.toThrow("Books/test.md");
// Expect: error contains filePath
```
**Covered by test H4 in suite.**

## E4 — filesystem permission denied on mkdir

```ts
// Mock: vault.adapter.exists → false
// Mock: vault.adapter.mkdir → throws "PERMISSION_DENIED"
await expect(syncManager.downloadFile(file, Date.now())).rejects.toThrow("Books");
// Expect: error contains folder path
```
**Covered by test H1 in suite.**

## N1 — downloadFile mkdir throws FOLDER_NOTCREATED

Covered by automated test. Run:
```bash
npm run test -- src/sync-manager.test.ts -t "includes folder path in error when mkdir fails"
```
**Expected:** passes.

## N2 — downloadFile writeBinary throws FILE_NOTCREATED

```bash
npm run test -- src/sync-manager.test.ts -t "includes file path in error when writeBinary fails"
```
**Expected:** passes.

## N3 — deleteLocalFile remove throws FILE_NOTFOUND

```bash
npm run test -- src/sync-manager.test.ts -t "includes file path in error when remove fails"
```
**Expected:** passes.

## N4 — non-404 blob fetch throws

```bash
npm run test -- src/sync-manager.test.ts -t "includes file path in error when blob fetch fails"
```
**Expected:** passes.

## N5 — firstSyncFromLocal read fails (MANUAL — needs implementation fix first)

Gap: `firstSyncFromLocal()` read at `sync-manager.ts:408` is unwrapped.

```ts
// To verify gap: mock vault.adapter.read → throws "FILE_NOTFOUND"
// Call firstSyncFromLocal() path indirectly
// Expected (current behavior): throws "FILE_NOTFOUND" — no path context
// Expected (after fix): throws "Failed to read file <path>: FILE_NOTFOUND"
```
**Status: [ ] Manual check — currently FAILING to include path (the bug exists).**

## Run all automated scenarios

```bash
npm run test -- src/sync-manager.test.ts
```
Expected: 7/7 passing.
