# Startup reply capture

These models describe one incomplete startup terminal reply, its late tail,
and a control or ordinary input event. They do not model a general terminal
decoder or prove the TypeScript binary.

The rejected expiry candidate inserted `pending.slice(2)` into the editor
after 250 ms. A controller test sent `ESC[?`, waited 275 ms, then sent `7u`.
It observed `?` after expiry and `?7u` after the tail. The expiry model detects
that same prefix → expiry → late-tail schedule.

The corrected [keyboard controller](../../../src/ui/app-keyboard.ts) retains
the prefix without an expiry timer. A recognized reply is consumed. A new ESC
sequence or standalone C0 byte starts a separate route. Ctrl+C then reaches its
existing action. Terminal cleanup clears the pending prefix.
The checked source snapshot is `b44b63aa13d463ce235f517920e82b5633000504`.

| Model | Expected TLC result | Recorded result |
|---|---|---|
| `fixed/StartupReplyCapture.tla` | Exit 0; both safety invariants pass | 12 generated states, 9 distinct states, empty queue, depth 4 |
| `expiry/StartupReplyCapture.tla` | Exit 12; `ReplySafety` fails | 6 distinct states, depth 4; prefix → expiry → late tail |

Use the official TLA+ tools v1.7.4 jar and Java 11 or newer. This check used
Temurin 27 and the cached jar from the [lifecycle model](../README.md).
Run each command from this directory with a fresh state directory:

```sh
java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir "$(mktemp -d)" -config fixed/StartupReplyCapture.cfg fixed/StartupReplyCapture.tla
java -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir "$(mktemp -d)" -config expiry/StartupReplyCapture.cfg expiry/StartupReplyCapture.tla
```

The abstraction tracks prefix presence, one reply completion, one control
action, and ordinary input routing. Elapsed time is a stuttering step in the
fixed model. Deadlock checking is disabled because the projection ends when
normal input takes over. Neither model establishes liveness, repeated-reply
behavior, byte-level parsing, or the cause of the historical startup report.
The matching controller regressions are in
[ui-startup-cleanup.test.ts](../../../test/ui-startup-cleanup.test.ts).
