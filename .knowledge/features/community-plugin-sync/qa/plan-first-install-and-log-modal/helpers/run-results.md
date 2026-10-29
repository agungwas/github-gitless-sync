# QA execution log

## Headed Playwright — LogsModal

- Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node .knowledge/features/community-plugin-sync/qa/plan-first-install-and-log-modal/helpers/qa-run.mjs`
- Run at: 2026-10-29 10:27 WIB
- Result: PASS — table columns, default-collapsed details, pointer row activation, Enter/Space activation, text selection, independent falsey values, malformed rows, safe text rendering, 8 KiB JSON wrapping, 390 px viewport with horizontal Level-column access, raw copy, clean, close, and stale async-load guard.
- Mobile layout: viewport 390 px; document 390 px; content 326 px; content scroll width 383 px; details use `overflow-wrap: anywhere` and `white-space: pre-wrap`.
- Screenshots: `../logs-desktop.png`, `../logs-expanded.png`, `../logs-mobile.png`, and `../logs-mobile-right.png`.
- Host limitation: browser harness stubs Obsidian host classes; no Obsidian vault was opened.

## Full Vitest suite

- Command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run`
- Run at: 2026-10-29 10:21 WIB
- Result: PASS — 26 files, 281 tests.

## Follow-up — preserve mkdir cause

- RED: `src/fs-paths.test.ts` failed as expected; follow-up `exists` error `EIO` replaced original mkdir `EACCES` cause.
- GREEN command: `/Users/agung.pratama/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run src/fs-paths.test.ts`
- GREEN: PASS — 1 file, 6 tests.
- Final suite: PASS — 26 files, 282 tests; TypeScript check and production esbuild build passed.
