# Shell preview model

`ShellPreview.lean` proves the fixed model keeps the retained prefix within
8,192 UTF-16 code units. It proves that the same transition makes a truncation
notification visible. It also proves that later chunks do not change the
retained prefix after truncation. TLC checks the exact fill and surrogate
split traces in the fixed model. The legacy configuration must fail
`VisibleTruncation` on its second chunk.

| Model event | Source mapping |
|---|---|
| Consume one chunk and append its retained units | `src/shell.ts:68-86`. `writeChunk` calls it at line 292. Decoder tails call it at lines 356-362. |
| Put the truncation flag in the notification snapshot | `src/shell.ts:230-243,292,358-362`. The `appendPreview` return value guards `notify()`. |
| Drop the last retained code unit at a pair boundary | `src/shell.ts:80-86`. `splitPairAtCut` represents the checks at `charCodeAt(end - 1)` and `charCodeAt(end)`. |
| Stop after first truncation and notify when truncation starts | `src/shell.ts:69-86`. Empty input and later input return `false`. Both overflow paths set truncation and return `true`. |

The model counts JavaScript UTF-16 code units after `StringDecoder`. The
exact fill trace is `[8192, 1, 1]`. The split trace is
`[8191, (2, pair across cut), 1]`. Its final chunk checks that truncation
leaves a one-unit gap unchanged.

The model does not store string contents. It stores code-unit counts and one
boundary flag. It does not model UTF-8 decoding, stdout and stderr, file
output, process events, or the TypeScript binary. Lean and TLC prove only the
extracted transitions. Source mapping and the process-output regression give
separate evidence for their relation to the source.

Recorded verification uses Lean 4.35.0, TLC 2.19, and Eclipse Temurin Java 27.
Lean exits 0. `fixedFiniteTraceInvariant` reports
`[propext, Classical.choice, Quot.sound]`. `fixedRunAfterTruncation` reports
`[propext]`. Neither theorem reports `sorryAx`.

Legacy TLC exits 12 with a `VisibleTruncation` counterexample. It finds 3
distinct states at depth 3. Fixed TLC exits 0. It checks 8 distinct states at
depth 4 across both traces.

Run these commands from the repository root. Use the supplied cached tools:

```sh
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean verification/lean/ShellPreview.lean
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir /private/tmp/phi-shell-preview-legacy-r2 -config verification/tla/shell-preview/legacy.cfg verification/tla/shell-preview/ShellPreview.tla
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir /private/tmp/phi-shell-preview-fixed-r2 -config verification/tla/shell-preview/fixed.cfg verification/tla/shell-preview/ShellPreview.tla
```

The raw outputs are captured at
`/Users/rexliu/phi/.superpowers/sdd/2026-10-26-usability/shell-formal`.
