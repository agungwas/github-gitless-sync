# QA Scenarios — plan-fix-events-localpath-lookup

Runtime: unit test (vitest inline)

## H1 — Normal file created by user

**Setup:** Empty metadata.
**Action:** `onCreate({ path: "foo.md" })`
**Expected:** `metadata["foo.md"] = { sha: null, dirty: true, justDownloaded: false }`

## H2 — Sanitized file download: create event clears justDownloaded, no ghost entry

**Setup:** `metadata["foo >.md"] = { sha: "abc", justDownloaded: true, localPath: "foo ＞.md" }`
**Action:** `onCreate({ path: "foo ＞.md" })`
**Expected:**
- `metadata["foo >.md"].justDownloaded === false`
- No new `metadata["foo ＞.md"]` entry created

## H3 — Normal file modified

**Setup:** `metadata["foo.md"] = { sha: "abc", dirty: false, lastModified: 100 }`
**Action:** `onModify({ path: "foo.md" })`
**Expected:** `metadata["foo.md"].dirty === true`, `lastModified` updated

## H4 — Sanitized file modified after download

**Setup:** `metadata["foo >.md"] = { sha: "abc", dirty: false, localPath: "foo ＞.md" }`
**Action:** `onModify({ path: "foo ＞.md" })`
**Expected:** `metadata["foo >.md"].dirty === true`
**Also:** No crash (pre-fix would access undefined key)

## H5 — Normal file deleted

**Setup:** `metadata["foo.md"] = { sha: "abc", deleted: false }`
**Action:** `onDelete("foo.md")`
**Expected:** `metadata["foo.md"].deleted === true`

## H6 — Sanitized file deleted

**Setup:** `metadata["foo >.md"] = { sha: "abc", deleted: false, localPath: "foo ＞.md" }`
**Action:** `onDelete("foo ＞.md")`
**Expected:** `metadata["foo >.md"].deleted === true`
**Also:** No ghost deletion (old code returned early, leaving entry non-deleted)

## H7 — Sanitized file renamed

**Setup:** `metadata["foo >.md"] = { sha: "abc", deleted: false, localPath: "foo ＞.md" }`
**Action:** `onRename({ path: "bar.md" }, "foo ＞.md")`
**Expected:**
- `metadata["bar.md"] = { sha: null, dirty: true }` (new entry)
- `metadata["foo >.md"].deleted === true` (correct entry marked deleted, not ghost)

## E1 — Empty metadata

**Setup:** `metadata = {}`
**Action:** `onCreate({ path: "foo.md" })`
**Expected:** No crash; `metadata["foo.md"]` created

## E2 — Concurrent create events for same sanitized file

**Setup:** `metadata["foo >.md"] = { sha: "abc", justDownloaded: true, localPath: "foo ＞.md" }`
**Action:** `onCreate({ path: "foo ＞.md" })` called twice
**Expected:** `justDownloaded === false`, no ghost, second call is idempotent

## N1 — Modify event for file not in metadata (pre-existing behavior)

**Setup:** Empty metadata.
**Action:** `onModify({ path: "foo.md" })`
**Expected:** TypeError (pre-existing, not regressed by this change)
**Note:** This is a pre-existing bug; document, do not fix in this plan.

## N2 — Delete event for untracked file

**Setup:** Empty metadata.
**Action:** `onDelete("foo.md")`
**Expected:** Early return, no crash, metadata unchanged.

## N3 — Rename event for non-syncable paths

**Setup:** `settings.syncConfigDir = false`, both paths in configDir
**Action:** `onRename({ path: ".obsidian/foo.md" }, ".obsidian/bar.md")`
**Expected:** No metadata changes.
