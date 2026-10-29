# UX, empty-state, and accessibility critique

Date: 2026-10-29

No actionable findings confirmed in this angle.

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|

## Evidence inspected

- Reviewed the parent-provided implementation diff for `src/settings/logs-modal.ts`, `styles.css`, and the uninstall conflict labels. The modal preserves three column headers, text-only rendering, hidden-by-default data, independently expandable rows, a focusable button, `aria-expanded`, `aria-controls`, and a visible focus style. Rows without data retain ordinary text.
- Inspected `logs-desktop.png` directly with `view_image`. The table places Level after Message and renders expanded `null`, `false`, and `0` as literal values beneath the message.
- Inspected `logs-mobile.png` directly with `view_image`. Long data wraps within the message column. The horizontal scrollbar exposes the wider table, which is allowed by the plan's wrapping/scrolling criterion; the Level column is initially outside the narrow viewport.
- The parent separately reproduced message drag-selection in the headed browser and reported that `aria-expanded` stayed `false`. The unguarded button click listener was therefore excluded as an unconfirmed concern.

## Scope limits

The browser screenshots use the shipped modal source and stylesheet with an Obsidian host shim. They do not establish appearance under every Obsidian theme, real Android touch behavior, or screen-reader announcements. These are execution coverage limits, not confirmed code defects.

Evidence record: `.omo/evidence/qa-ux-20261029.md`.
