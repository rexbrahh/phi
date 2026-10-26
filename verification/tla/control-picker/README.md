# Control picker race model

The Lean model proves two state invariants by induction over every finite action trace. TLC checks the corresponding invariants for this finite TLA+ model. Neither checks TypeScript equivalence or native SDK behavior.

| Model event | Source mapping |
|---|---|
| Escape stales the request while validation remains pending | `app-control-picker.ts:79-87,93-107`: `hide` advances `requestId`; `applySelection` passes the visibility and request-token predicate. |
| Validation returns, then native control may be issued | `app.ts:496-526`: `applyControlPickerChoice` rechecks session and picker after `supportedModels`; effort validation also rechecks after `getContextUsage`. |
| Acknowledgement may update only its still-current session | `app.ts:505-508,524-528`: after the native setter, the session snapshot is checked before selection is written. Popup closure does not cancel an issued native call. |

`ValidationReturns` combines the final validation await, the synchronous current-request/session guards, and the immediately issued native call. This matches the source's lack of an event-loop yield between the guard and setter. The fixed TLC configuration includes the picker-token guard. The legacy configuration removes only that guard; TLC should produce an `Escape`, `ValidationReturns` counterexample while validation is pending. Bounds are one picker request, one captured session, one replacement session, one model choice, and Boolean lifecycle flags. There are no fairness or liveness claims.

`requestCurrentAtValidationReturn` records picker validity independently of `nativeIssued`. `NoStaleAckUpdate` requires the replacement selection to remain selected after the captured session is replaced, including when its old native call later acknowledges.

Recorded with TLC 2.19: fixed checked 28 generated states (11 distinct, depth 4) with no error; legacy stopped at the `NoIssueAfterCancel` counterexample after 6 generated states (5 distinct, depth 3).

Reproduce with Lean 4.35.0 and the installed TLA+ tools. The separate TLC metadata directories avoid run collisions:

```sh
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean verification/lean/ControlPicker.lean
cd verification/tla/control-picker
mkdir -p /private/tmp/control-picker-fixed /private/tmp/control-picker-legacy
java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -metadir /private/tmp/control-picker-fixed -config ControlPicker-fixed.cfg ControlPicker.tla
java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -metadir /private/tmp/control-picker-legacy -config ControlPicker-legacy.cfg ControlPicker.tla
```

The TLC jar filename does not identify its engine version; report the version printed by the installed jar. The model captures the race and guards, not the TypeScript binary, SDK internals, macOS scheduling, terminal rendering, or GUI behavior. The causal implementation test is `test/ui-usability.test.ts:99-113`.
