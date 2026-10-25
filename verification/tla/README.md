# Phi session lifecycle model

This directory contains a bounded TLA+ model of the session callback and
interaction queue lifecycle. TLC checks the listed safety invariants for the
finite bounds in `PhiLifecycle.cfg`.

## Findings and model treatment

| Issue | Proposed model treatment | Source evidence |
|---|---|---|
| A callback from a noncurrent query can change visible, session, or request state. | Give every query instance a separate token. Permit writes only when the callback token equals the current process-generation token. | [`app.ts`](../../src/ui/app.ts#L579) captures `generation` in `isCurrent`. [`app-session-observer.ts`](../../src/ui/app-session-observer.ts#L36) rejects stale permission, elicitation, hook, message, and error callbacks. |
| Repeated session close can call native query close more than once. | Count native close calls per query. The normal model memoizes repeated close requests. | [`session.ts`](../../src/session.ts#L103) stores `closePromise`; [`session.ts`](../../src/session.ts#L168) returns it before another `query.close()` call. |
| Foreground interrupt can change background membership without an SDK update. | Keep the background set unchanged during interrupt. Only a current `background_tasks_changed` message can change it. | [`app.ts`](../../src/ui/app.ts#L460) calls `query.interrupt()` and reports the result. [`state-tasks.ts`](../../src/state-tasks.ts#L82) updates membership from `background_tasks_changed`. |

The model publishes close ownership before another close request can act.
Source review found that `Session.close()` previously stored its promise after
calling external code. A synchronous `onClosing` callback could re-enter it.
The regression recorded two native closes and different returned promises.
Commit `0916251` publishes the promise before `query.close()` and `onClosing`,
so the source has the modeled linearization point. The regression now passes
with one native close, one closing callback, and one shared promise. It also
checks synchronous calls and native-close error priority.

The lifecycle test contains 46,656 bounded queue traces and 12 session race
cases. On `0916251`, all 324 deterministic tests and all 13 PTY scenarios
passed. These implementation checks remain separate from the model result.

## Bounds and identity

The positive model has these finite bounds:

| Entity | Bound | Purpose |
|---|---:|---|
| Query-instance tokens | 2 | Initial query and at most one replacement query. |
| SDK session IDs | 2 | A query can resume either ID, including an ID used before. |
| Request IDs | 2 | Two queue keys can be active or settled. |
| Allocation tokens | 4 | One fixed token for each query and request ID pair. |
| Background task IDs | 2 | Four possible membership sets. |

## Queue allocation scope

The TLC model checks query-generation ownership only for queue allocations.
`RequestAllocationOwned` requires each active allocation to belong to the
current query token. It does not represent a callback that holds an old
`ActiveRequest` object after request-ID reuse.

`ResolveRequest(r)` represents a current user answer selected by request ID
`r`. It settles the allocation in `activeByRequest[r]`. It carries no
`ActiveRequest` identity and does not represent an abort callback.

The model has one allocation token for each query and request ID pair. It does
not model standalone `cancelPending()` followed by reuse of the same request ID
within one query. The separate Lean model checks allocation identity after
settlement and same-ID reuse after `cancelPending()`. See the [Lean model](../lean/InteractionQueue.lean)
and its [README](../lean/README.md).

The design keeps allocation checks in Lean and query-race checks in TLC. Each
result applies to its own model. The two models do not prove a combined
property.

Query tokens and SDK session IDs are separate sets. `OpenTarget(sid)` can
assign either session ID to the replacement query token. The model has no
ordering between query tokens or session IDs. It permits a resume to reuse an
ID. The one-replacement bound does not check a longer rollback sequence.

The model represents failed resume as a current query token whose open failed.
Phi closes that query and clears its session pointer, but it does not increment
`processGeneration` again. The token remains current until another session
transition invalidates it. Output-stream completion can also clear the session
pointer while the generation token remains current. See `app.ts:612–640` and
`app.ts:659–673`.

The model permits callback actions from a noncurrent query token. TLC does not
establish which callbacks the SDK or operating system emits, or when it emits
them.

## Transition map

| Model action | Source behavior represented |
|---|---|
| `Invalidate` | Cancel pending allocations, clear settled IDs, then advance `processGeneration` before closing the prior session. |
| `CloseRequest`, `CloseComplete` | Call native `query.close()` once, then wait for readiness and output completion. Repeated `Session.close()` calls reuse `closePromise`. |
| `OpenTarget` | Install a new query instance after the prior session closes. Select an SDK session ID independently. |
| `ResumeFailure` | Report initialization failure, close the replacement session, and clear the session pointer without advancing the generation token. |
| `OutputEnded` | A replacement session's output iterator ends and the app clears its session pointer. |
| `MessageCallback`, `ErrorCallback`, `RequestCallback`, `BackgroundUpdate` | Apply or reject callbacks through the captured current-generation guard. The callback mutant removes that guard. |
| `ResolveRequest` | Apply a current user answer selected by request ID to the active queue allocation. |
| `Interrupt` | Call `query.interrupt()` without changing background membership. |
| `BackgroundUpdate` | Apply an actual current SDK `background_tasks_changed` message. |

`CloseRequest` can stutter after `closePromise` exists. This represents the
source branch that returns the existing promise. The model has no general idle
action. `Spec` uses standard TLA+ stuttering with `[][Next]_vars`. TLC's default
deadlock check remains enabled. No deadlock-suppression option was passed.

## Safety properties

- `CallbackStateOwned`: only a current callback token can own the latest
  callback-driven visible or session-state write.
- `RequestAllocationOwned`: every active queue allocation belongs to the
  current query token.
- `NativeCloseAtMostOnce`: each query instance causes at most one native close
  call.
- `InterruptPreservesBackground`: the background set after an interrupt equals
  its value before that interrupt. A later actual background update may change
  it.
- `TypeOK`: all modeled variables stay within their finite domains.

The model checks safety only. It uses no fairness assumption and makes no
liveness claim. The model is not an unbounded proof of the TypeScript program.
It does not check SDK internals, native query behavior, OS scheduling, terminal
rendering, or the full set of UI events.

## Tool source

The model was checked with the official stable `tlaplus/tlaplus` v1.7.4
`tla2tools.jar` asset. The official release lists SHA-1
`bee4a54f3ee3d4afc347c3240ec2d9e93b075104` for the jar:
[v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
The official project README states that TLA+ tools require Java 11 or newer
and its CI uses Java 17:
[TLA+ tools README](https://github.com/tlaplus/tlaplus/blob/master/README.md),
[official CI workflow](https://github.com/tlaplus/tlaplus/blob/master/.github/workflows/main.yml).

This run used `/usr/bin/java`, Temurin 27+35. The listed Zulu 17 home did not
contain an executable `bin/java`, and `java_home -v 17` selected Temurin 27.
The downloaded jar SHA-256 was
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
TLC reported version 2.19 of 08 August 2024, revision `5a47802`.

The positive run checked 1,149,707 generated states and 67,154 distinct
states to an empty queue. The complete graph depth was 18. It passed all five
invariants and returned exit code 0. Both mutant runs returned exit code 12
with the expected invariant counterexample.

## Reproduction

The checked jar is outside the repository at
`/private/tmp/tla2tools-v1.7.4.jar`. The reproduction commands use one worker
and separate temporary state directories. Run them from the repository root.

```sh
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC \
  -workers 1 \
  -seed 20261025 \
  -metadir /private/tmp/phi-tlc-positive \
  -config verification/tla/PhiLifecycle.cfg \
  verification/tla/PhiLifecycle.tla
```

Two intentionally broken configurations serve as negative controls. They are
mutant models, not Phi bug reports.

```sh
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC \
  -workers 1 \
  -seed 20261025 \
  -metadir /private/tmp/phi-tlc-mutant-callback \
  -config verification/tla/PhiLifecycle-mutant-broken-callback-guard.cfg \
  verification/tla/PhiLifecycle.tla
```

The callback mutant violates `CallbackStateOwned` on this trace:
`Init` → `Invalidate(q1)` → `ErrorCallback(q0)`. The error callback runs while
the model is switching, after invalidation and before the replacement opens.
It sets `sessionError` to `sdk-error` and `callbackOwner` to `q0` while
`current` is `NoQuery`.

```sh
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC \
  -workers 1 \
  -seed 20261025 \
  -metadir /private/tmp/phi-tlc-mutant-close \
  -config verification/tla/PhiLifecycle-mutant-broken-close-memoization.cfg \
  verification/tla/PhiLifecycle.tla
```

This close mutant must report a `NativeCloseAtMostOnce` counterexample after
two calls to the intentionally nonmemoized close action.
