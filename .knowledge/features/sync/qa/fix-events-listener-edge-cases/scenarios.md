# QA Runbook — plan-fix-events-listener-edge-cases

Non-FE (backend event-handling logic, no UI touched). All scenarios are automated
via `src/events-listener.test.ts` — no manual-only steps.

| # | Scenario | Command | Result |
|---|---|---|---|
| H1 | Modify a tracked file (regression) | `npm run test -- --run src/events-listener.test.ts -t "F1-T2"` | pass |
| H2 | Delete a normal (non-sanitized) folder (regression) | `npm run test -- --run src/events-listener.test.ts -t "F2-T4"` | pass |
| E1 | Delete a folder whose disk name was sanitized (unicode `＞` vs remote `>`) | `npm run test -- --run src/events-listener.test.ts -t "F2-T3"` | pass |
| N1 | Modify a file with no metadata entry (event ordering: modify before create) | `npm run test -- --run src/events-listener.test.ts -t "F1-T1"` | pass |

Run all four in one pass:
```
npm run test -- --run src/events-listener.test.ts
```
