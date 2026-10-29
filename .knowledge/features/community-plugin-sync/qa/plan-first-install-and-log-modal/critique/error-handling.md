# Error-handling critique

Reviewed the supplied tracked diff and full untracked filesystem-helper source. No implementation files were changed.

| Severity | Angle | File:line | Finding | Suggested fix |
|---|---|---|---|---|
| minor | error-handling | src/fs-paths.ts:70 | If `mkdir` fails and its existence recheck also fails, `pathExists` throws from inside the catch block. That replaces the original mkdir failure with the recheck failure, violating the plan's original-cause requirement and hiding the initiating filesystem error. The operation still fails, so this is a diagnostic defect. | Catch the recheck failure, retain the mkdir error as `cause`, and include the recheck diagnostic in the wrapper message or a secondary error field. |

Evidence: an isolated JavaScript execution of the supplied catch path with mkdir `EACCES` followed by recheck `EIO` reported `originalCausePreserved: false` and `reportedCause: "recheck EIO"`. This confirms control flow; it is not a new production test or physical-device result. Full evidence: `.omo/evidence/iris-qa-error-handling.md`.
