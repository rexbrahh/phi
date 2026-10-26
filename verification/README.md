# Lifecycle verification

Phi uses two formal methods for lifecycle invariants. Each model maps its
transitions to the TypeScript guards that it represents.

| Method | Scope | Reproduce |
|---|---|---|
| Lean 4 | Per-allocation settlement, closed queues, and stale settled-allocation callbacks | [Queue proofs](lean/README.md) |
| TLA+ with TLC | Bounded session ownership, native close calls, query ownership of requests, and foreground interruption | [Lifecycle model and negative controls](tla/README.md) |
| TLA+ with TLC | Startup reply retention across an elapsed gap and a control-key boundary | [Reply model and expiry counterexample](tla/startup-replies/README.md) |
| Lean 4 and TLA+ with TLC | Atomic import-file publication, retry after failure, and completion-marker safety | [Import publication model and reproduction](tla/import-publication/README.md) |

The Lean theorems cover every reachable state of their extracted model. TLC
checks the finite bounds in its configuration. Neither result proves that the
TypeScript binary implements the model. The source maps and implementation
tests provide separate evidence for that relationship.

When an invariant fails:

1. Retain the implementation trace and identify the violated source guard.
2. Represent the relevant schedule in the model. Keep a failing negative
   control that demonstrates detection of the violation.
3. Fix the source and its causal regression. Update the model when its source
   mapping changes, then run the applicable Lean and TLC checks.
4. Report the checked source, tool versions, model bounds, terminal results,
   and remaining assumptions.

The implementation checks for the modeled queue and session behavior are:

```sh
npm run build
node --test dist/test/interactions.test.js dist/test/lifecycle-invariants.test.js
```

These models do not verify SDK internals, OS scheduling, terminal rendering,
or Workflow-child cancellation. They do not establish whole-application
correctness or liveness.
