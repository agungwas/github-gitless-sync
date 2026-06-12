---
iris_schema: 4
status: done
completed: "2026-06-12"
testing: tdd
---

# Add Sync in Progress Notice

## Goal
Show a notification to the user if they try to trigger a sync while another sync is already running.

## Context
Currently, if `this.syncing` is true, the `sync()` and `firstSync()` methods in `src/sync-manager.ts` simply log an info message and return early. The user clicks the button and nothing visually happens, causing confusion. We need to add an Obsidian `Notice` to inform them that a sync is already in progress.

## Approach
**Chose:** Add `new Notice("Sync already in progress")` inside the `if (this.syncing)` block of both `sync()` and `firstSync()` methods in `src/sync-manager.ts`.
**Over:** Throwing an error and letting the UI handle it.
**Why:** The chosen approach is the simplest, directly mimicking how the successful "Syncing..." and error notices are currently handled within `sync()`.

## Implementation Steps

1. **Update `src/sync-manager.ts` - `firstSync()`:**
   - Locate the `if (this.syncing)` block (around line 94).
   - Add `new Notice("First sync already in progress");` right before the `return;` statement.

2. **Update `src/sync-manager.ts` - `sync()`:**
   - Locate the `if (this.syncing)` block (around line 397).
   - Add `new Notice("Sync already in progress");` right before the `return;` statement.

## Test Scenarios
1. **Trigger `firstSync` while syncing:**
   - Setup: Mock `Notice`, set `syncManager['syncing'] = true`.
   - Action: Call `syncManager.firstSync()`.
   - Assert: `Notice` should be instantiated with `"First sync already in progress"`.

2. **Trigger `sync` while syncing:**
   - Setup: Mock `Notice`, set `syncManager['syncing'] = true`.
   - Action: Call `syncManager.sync()`.
   - Assert: `Notice` should be instantiated with `"Sync already in progress"`.

### Failure Verification
```
Command: npm run test -- src/sync-manager.test.ts
Test files:
  - src/sync-manager.test.ts
  - vitest.config.ts
  - vitest.setup.ts
Run at: 2026-06-12 14:32
Result: 2 new tests, all failing with valid TDD reasons
Sample failure (one per new test):
  - firstSync shows a Notice when already syncing → AssertionError: expected "vi.fn()" to be called with arguments: [ 'First sync already in progress' ]
  - sync shows a Notice when already syncing → AssertionError: expected "vi.fn()" to be called with arguments: [ 'Sync already in progress' ]
```

## Open Questions
- Should the duration of the Notice be different from the default? (Default is fine unless specified).

## Deviations
Baseline: clean except iris-2-write-tests new tests (expected)
Command: `npm run test`
Final run: All 18 tests passed successfully.
Command: `npm run test`

| What changed | Why | Update feature doc? |
|---|---|---|
| None | N/A | no |


