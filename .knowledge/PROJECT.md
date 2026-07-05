---
iris_schema: 5
plan_retention_days: 4
updated: "2026-07-05"
# composite_max_parents: 2
---
# Project Overview

## Testing Stack & Patterns

- **Framework**: Testing is implemented using `vitest` with `@testing-library/react` and `jsdom`.
- **Obsidian API Mocks**: The Obsidian API is not available in Node.js. Globals and Obsidian dependencies are mocked within `vitest.setup.ts`. For example, classes like `Plugin`, `ItemView`, `Modal`, and globals like `localStorage` are stubbed out. Classes extended at module-load time (e.g. `class Foo extends Modal`) need their base mocked in the shared `vitest.setup.ts`, not just a per-test-file override — a class-definition-time `extends` evaluates immediately on import, before any test-local `vi.mock()` can help.
- **Coverage**: Coverage is tracked using `@vitest/coverage-v8`.
- **Execution**: Run tests using `npm run test` or with coverage `npm run test -- --coverage`.
