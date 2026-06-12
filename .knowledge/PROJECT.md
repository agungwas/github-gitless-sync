---
iris_schema: 4
plan_retention_days: 4
updated: "2026-06-12"
# composite_max_parents: 2
# parallel:
#   plan_worktree_root: .worktrees/plans
---
# Project Overview

## Testing Stack & Patterns

- **Framework**: Testing is implemented using `vitest` with `@testing-library/react` and `jsdom`.
- **Obsidian API Mocks**: The Obsidian API is not available in Node.js. Globals and Obsidian dependencies are mocked within `vitest.setup.ts`. For example, classes like `Plugin`, `ItemView`, and globals like `localStorage` are stubbed out.
- **Coverage**: Coverage is tracked using `@vitest/coverage-v8`.
- **Execution**: Run tests using `npm run test` or with coverage `npm run test -- --coverage`.
