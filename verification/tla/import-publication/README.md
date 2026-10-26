# Import publication verification

The source maps `LegacyOpenTarget` and `LegacyPostOpenFailure` to
`mergeEntry` opening the final file before its staged read/write. The retry
action skips that existing path; `PublishMarker` follows the merge loop.
`AtomicLink` abstracts non-overwriting hard-link publication of a complete
staged file. It assumes staging and destination are on the same filesystem,
link creation does not overwrite, and the namespace exposes the link atomically.
It does not prove TypeScript behavior, kernel behavior, or crash durability.

The finite projection has one staged regular file and at most two attempts.
The legacy path injects one post-open read/write failure; retry stages again,
skips the partial final path, then publishes completion. The atomic path may
instead fail before link creation, leaving the target absent for one retry.
Initial target is either absent or pre-existing. `NoIncompleteCompletion`
checks marker safety; `AtomicPublicationIsWhole` checks the fixed abstraction
(and is vacuous in the intentionally failing legacy config); the preservation
invariant checks pre-existing content. `CompletedHold` gives terminal states
an explicit self-loop. TLC deadlock checking stays enabled. No fairness or
liveness property is asserted.

The legacy config must report a `NoIncompleteCompletion` counterexample with
this action order: `PrepareFirst`, `LegacyOpenTarget`,
`LegacyPostOpenFailure`, `RetryStage`, `LegacyRetrySkipsPartial`,
`PublishMarker`. The atomic config must finish with an empty queue and pass all
four invariants. These checks cover only the stated abstraction.

Recorded checks used Lean 4.35.0 and TLC 1.7.4. Lean exited 0 and reported
`[propext]` for `fixedFiniteTraceInvariant`, with no unfinished proofs. Legacy
TLC exited 12 with the intended counterexample: 11 distinct states, depth 7.
Atomic TLC exited 0 with 12 distinct states, depth 6, and an empty queue.

Run from the repository root with cached tools:

```sh
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean --version
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean verification/lean/ImportPublication.lean
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir /private/tmp/phi-import-publication-legacy -config verification/tla/import-publication/legacy.cfg verification/tla/import-publication/ImportPublication.tla
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir /private/tmp/phi-import-publication-atomic -config verification/tla/import-publication/atomic.cfg verification/tla/import-publication/ImportPublication.tla
```
