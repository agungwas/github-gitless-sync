---
status: "done"
completed: "2026-06-12"
type: "implementation"
testing: "tdd"
---
# Plan: Force Save Before Sync

## Goal
Fix the critical mobile bug where data loss occurs because Obsidian's editor defers writing changes to the file system. Ensure that `sync()` forces all open text editors to flush their in-memory content to disk before any sync operations begin.

## Approach
**Chose:** Add a routine to `GitHubSyncPlugin.sync()` that iterates through all open `TextFileView` instances and awaits their `save()` methods before doing anything else.
**Over:** 
- *Locking the screen during auto-sync*: Rejected because it steals focus and ruins the user's typing flow every few minutes.
- *Do nothing*: Rejected because users continue to experience irrecoverable data loss when auto-sync fires before the delayed file system flush.
**Why:** The chosen path uses native Obsidian APIs to flush memory to disk safely, ensuring `adapter.read()` will always fetch the correct data without interrupting the user.

## Implementation Steps

### Step 1: Import `TextFileView`
**File:** `src/main.ts`
**Action:** Add `TextFileView` to the existing imports from `"obsidian"`.

### Step 2: Force save editors at the start of `sync()`
**File:** `src/main.ts`
**Action:** At the very top of the `async sync()` method (before the `if (this.settings.githubToken === "" ...)` check), add logic to iterate all leaves, collect `save()` promises for `TextFileView` instances, and await them.

```typescript
    // Force flush all open editors to disk
    const savePromises: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView) {
        savePromises.push(leaf.view.save());
      }
    });
    
    // Wait for all saves to finish
    await Promise.all(savePromises);
```

## Test Scenarios

| # | Scenario | Setup | Expected |
|---|---|---|---|
| H1 | force saves all open text editors | mock workspace leaves with and without TextFileView | `save()` is called on TextFileView instances before sync |

### Failure Verification
Command: `npx vitest run`
Test files:
  - src/main.test.ts
Run at: 2026-06-12 15:10
Result: 1 new test, failing with valid TDD reason
Sample failure:
  - force saves all open TextFileView instances before syncing -> AssertionError: expected "vi.fn()" to be called at least once

## Open Questions
None.
