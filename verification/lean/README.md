# Lean model of `InteractionQueue`

This directory contains a small Lean 4 model of the allocation lifecycle in
`src/interactions.ts`. It proves three invariants for the model. It does not
prove equivalence with the TypeScript program or correctness of the full app.

## Reproduce

Use Lean 4.35.0 with its bundled `Std` library. The proof imports no other
library.

```sh
lean --version
lean InteractionQueue.lean
```

The verification run used the official stable release asset
`lean-4.35.0-darwin_aarch64.zip` from
<https://github.com/leanprover/lean4/releases/tag/v4.35.0>.
The official GitHub release API reported SHA-256
`55132a570e3dfc6203626944b262793c0f0f6a8230c0d09344a06ac992fac4a9`.
The run used macOS arm64. No package manager or project dependency changed.
Each `#print axioms` command reports `[propext, Quot.sound]`. These are Lean's
propositional extensionality and quotient soundness foundations. The output
does not list `sorryAx`, `Classical.choice`, or a project axiom.

## Source mapping

| Lean model | TypeScript source | Meaning |
|---|---|---|
| `Allocation` | `ActiveRequest` returned by `createActive` | One allocation identity. A token is not a request ID. |
| `active` | `activeRequests.get(requestId)` | The selected request ID's current active allocation. |
| `settledCache` | `settledRequests.get(requestId)` | The selected request ID's cached settled promise. |
| `settledTokens` | `ActiveRequest.settled` | A ghost set of allocations whose settlement flag is true. |
| `resolveCalls` | `active.resolve(result)` in `settle` | A ghost history of calls to the native promise resolver. |
| `allocate` | Successful `createActive` plus map insertion | A new allocation when the queue is open and the request ID is absent from both maps. |
| `settleToken` | `cancel` or a successful `answer`, then `settle` | A settlement attempt. The model checks the settled flag and current allocation identity. |
| `cancelPending` | `cancelPending` | Settle the current allocation, then clear the settled-promise cache. |
| `cancelAll` | `cancelAll` | The state after close and cancellation complete. |

The model uses one request-ID slot. Other request IDs do not change this slot's
transition rules. Same-kind active or cached requests reuse their promise.
Conflicting requests and invalid question input do not allocate an
`ActiveRequest`. The `allocate` action represents only a successful allocation
path.

The model splits allocation from abort handling. This covers
`watchAbort`: an already-aborted signal can settle the just-created allocation
before the enqueue method returns. `answer`, `cancelRequest`, and abort
callbacks all use the modeled settlement action when they settle an active
allocation.

`cancelAll` is one transition at public method boundaries. The source sets
`closedReason` before it calls `cancelPending`. Both operations are synchronous,
and `cancelPending` does not inspect `closedReason`. The model records the state
after the method returns. It does not represent intermediate statements inside
that call.

## Proved properties

`reachable_invariant` proves initialization and preservation for every model
transition. The following theorems use that reachability result:

- `nativePromise_resolves_at_most_once`: `resolveCalls` has no duplicate
  allocation token. This is a resolver-call count per `ActiveRequest`, not per
  request ID.
- `closed_queue_cannot_allocate`: after close, a reachable queue cannot create
  an active allocation.
- `settled_stale_action_preserves_current`: a settlement action for a settled
  allocation leaves the current allocation unchanged. The stronger theorem
  `settled_stale_action_is_noop` proves that it leaves the whole model state
  unchanged. `reachable_stale_settled_action_preserves_current` also proves
  that the settled token differs from the current token in every reachable
  state.

`cancelPending` clears the cache and leaves the queue open. A later allocation
can use the same request ID with a larger allocation token. The proof therefore
does not claim that a request ID settles only once.

## Assumptions and evidence limits

The model assumes synchronous queue state transitions and treats each new
`ActiveRequest` object as a fresh natural-number token. It abstracts native
promise values, interaction payloads, event listeners, response validation,
and multiple IDs. It checks the settlement guards and map lifecycle, not
TypeScript compilation semantics or every caller.

Source evidence inspected for this model:

- `src/interactions.ts:72-109`: `answer`, `cancelAll`, and `cancelPending`.
- `src/interactions.ts:118-267`: both enqueue methods, `findExisting`,
  `hasRequestId`, `createActive`, and `watchAbort`.
- `src/interactions.ts:318-343`: `cancel` and `settle`.
- `src/interaction-types.ts:18-84`: request IDs and the `PendingInteraction`
  kind union. `ActiveRequest` remains private to `interactions.ts`.
- `src/ui/app-session-observer.ts:73-75` and `src/ui/app.ts:719,965`:
  session-change cancellation and shutdown cancellation callers.
- `test/interactions.test.ts:771-843`: cancellation after close and request-ID
  reuse after `cancelPending`.
- `test/lifecycle-invariants.test.ts:144-225`: bounded answer, abort,
  replacement, and close traces over promise identities.

The tests are source evidence only. This Lean result is a kernel-checked proof
of the stated model. It is not a claim that Lean verified the TypeScript binary.
