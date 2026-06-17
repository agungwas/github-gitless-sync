# QA Runbook — plan-fix-qa-findings

Non-FE runbook. Three fixes in `sync-manager.ts`: firstSyncFromLocal read wrap (F1), syncImpl lazy eval restore (F2), commitSync binary blob split (F3).

## H1 — firstSyncFromLocal read succeeds (no error)

```bash
npm run test -- src/sync-manager.test.ts -t "includes file path in error when read fails"
# Verify test passes — confirms happy path (read succeeds, no wrap fires)
```

## H2 — syncImpl upload uses resolution content; disk NOT read

Manual check: set `resolution.content = "resolved content"` for a file, mock `vault.adapter.read` to throw, call upload path → should succeed using resolution content.
**Status: [ ] Manual — no automated coverage (F2 coverage gap).**

## H3 — syncImpl upload reads disk when no resolution

Verified by existing upload tests and baseline passing.
**Status: [x] Covered by existing suite.**

## H4 — commitSync readBinary + createBlob both succeed

```bash
npm run test -- src/sync-manager.test.ts -t "commitSync binary blob"
# Both pass when mocks succeed
```

## E1 — resolution.content is empty string ""

Empty string is falsy → `if (resolution?.content)` falls through to disk read. Same behavior as original `|| await read()`. Pre-existing. Test manually:

```ts
// resolution.content = "" → disk read triggered (same as original behavior)
// Expected: reads from disk (consistent with original)
```
**Status: [ ] Manual — pre-existing behavior, not a regression.**

## E2 — firstSyncFromLocal text file at root (no dir separator)

Path `notes.md` normalizes to `notes.md`. Try-catch still fires if read fails.
**Status: [ ] Manual.**

## E3 — createBlob fails after readBinary succeeds

```bash
npm run test -- src/sync-manager.test.ts -t 'says "Failed to upload binary blob" when createBlob throws'
```
Expected: passes (error says "Failed to upload binary blob for images/photo.png").

## E4 — readBinary fails in commitSync

```bash
npm run test -- src/sync-manager.test.ts -t 'says "Failed to read binary file" when readBinary throws'
```
Expected: passes (error says "Failed to read binary file images/photo.png").

## N1 — firstSyncFromLocal read throws

```bash
npm run test -- src/sync-manager.test.ts -t "includes file path in error when read fails"
```
Expected: passes (error contains "Books/test.md").

## N2 — readBinary throws in commitSync

Covered by E4 above.

## N3 — createBlob throws in commitSync

Covered by E3 above.

## Run all automated scenarios

```bash
npm run test -- src/sync-manager.test.ts
```
Expected: 10/10 passing.
