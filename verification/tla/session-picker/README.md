# Session picker cancellation model

The finite model tracks one target, active work, and the 30-second `pendingTransition`
confirmation; `ExpireConfirmation` represents its deadline. Picker lookup results
require a visible picker and matching epoch; direct resume is unconditional.

| Source | Model |
|---|---|
| `src/ui/app.ts:179-182,706-716` clears on hide or open | `Escape`, `OpenPicker` |
| `src/ui/app.ts:734-745,1010-1023` confirms or stops active work | `PickerResume`, `DirectResume`, `MetadataReturns` |
| `src/ui/app.ts:1015-1019` checks visibility and epoch after lookup | `RequestCurrent`, `MetadataReturns` |

`FreshConfirmationRequired` detects a stop using an invalidated token;
`NoStalePickerStop` checks the metadata guard. The legacy config omits the cancel
clear and exposes the stale token. This does not prove TypeScript equivalence or
universal app correctness.

Reproduce with Lean 4.35.0 and TLC 2.19:

```sh
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean verification/lean/SessionPicker.lean
(cd verification/tla/session-picker && java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -metadir /private/tmp/session-picker-fixed -config SessionPicker-fixed.cfg SessionPicker.tla)
(cd verification/tla/session-picker && java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -metadir /private/tmp/session-picker-legacy -config SessionPicker-legacy.cfg SessionPicker.tla)
```
