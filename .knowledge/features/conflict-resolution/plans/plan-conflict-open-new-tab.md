---
status: done
completed: "2026-06-12"
type: implementation
testing: tdd
---
# Plan: Open Conflict in New Tab

## Goal
When a sync conflict happens, if the conflict view is already open in another tab, move focus to that tab. If it is not open and the current tab isn't an empty new tab page, open the conflict view in a new tab instead of replacing the current tab.

## Approach
- In `src/main.ts`, the `activateView()` method checks if `CONFLICTS_RESOLUTION_VIEW_TYPE` leaves exist. If yes, it reuses the first one.
- If not, check if the current active leaf (`workspace.getLeaf(false)`) has a view type of `"empty"`.
- If it is `"empty"`, we can safely replace it (`workspace.getLeaf(false)`).
- If it is NOT `"empty"`, we open a new tab (`workspace.getLeaf('tab')`).

## Implementation Steps
1. In `src/main.ts`, navigate to `activateView()`.
2. Update the `else` branch:
   ```typescript
   const activeLeaf = workspace.getLeaf(false);
   const isNewTabPage = activeLeaf && activeLeaf.view.getViewType() === "empty";
   leaf = workspace.getLeaf(!isNewTabPage ? 'tab' : false)!;
   ```
3. Call `await leaf.setViewState({ type: CONFLICTS_RESOLUTION_VIEW_TYPE, active: true });`.
4. Call `workspace.revealLeaf(leaf);` to focus the tab.

## Test Scenarios
- **Happy Path 1**: Reuses existing conflict view if already open (no new tab).
- **Happy Path 2**: Replaces current tab if active tab is an empty new tab page.
- **Edge Case 1**: Opens in a new tab if current tab is NOT empty.

### Coverage Gaps
None.

### Failure Verification
```text
Command: `npm test src/main.test.ts`
Test files:
  - src/main.test.ts
Run at: 2026-06-12 14:34
Result: 3 new tests, 1 failing with valid TDD reason (others pass on current behavior)
Sample failure (one per new test):
  - opens in a new tab if current tab is NOT empty → AssertionError: expected "vi.fn()" to be called with arguments: [ 'tab' ]
```

## Deviations
Baseline: Some pre-existing failures (`sync-manager.test.ts` - `firstSync shows a Notice when already syncing`, `sync shows a Notice when already syncing`).
Final run: `npm test` - 2 failed (baseline unchanged), 16 passed (including all 3 new tests from `src/main.test.ts`).

| What changed | Why | Update feature doc? |
|---|---|---|
| No deviations from the plan | Implementation perfectly matches the plan | no |

