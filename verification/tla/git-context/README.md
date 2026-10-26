# Local shell Git context

| Issue | Proposed fix | Evidence |
|---|---|---|
| An inherited `GIT_INDEX_FILE` can route a linked-worktree `git add` to another worktree's staged index. | Clear `GIT_INDEX_FILE`, `GIT_DIR`, and `GIT_WORK_TREE` for the local shell; retain signing and SSH environment. | An agent-owned disposable fixture reproduced the foreign-index change through compiled `runUserShell`. Both shell startup and workspace inspection now use `environmentForLocalGit`. |

The finite abstraction launches one shell with cwd `selected`, then performs
one staged-index operation. All three selectors start present. The operation
routes only by `GIT_INDEX_FILE`: present means the staged index belongs to a
foreign worktree; absent means it belongs to `selected`. `GIT_DIR` and
`GIT_WORK_TREE` are tracked only to check the clear-all launch contract. The
signing and SSH booleans represent unrelated inherited context and must remain
true. This isolates the supplied index-selector repro; it does not model Git's
full environment-variable precedence, kernel behavior, or other Git commands.

Lean proves `fixedFiniteTraceInvariant` for every finite action list under the
fixed transition. TLC's legacy config must fail `PreserveForeignStaging` after
`Launch`, `GitAdd`; the fixed config exhausts its finite graph and checks the
clear-all, index-preservation, selected-context, and signing/SSH invariants.
`DoneHold` is explicit terminal behavior. TLC deadlock checking stays enabled;
the spec has no fairness assumption or liveness claim. This model says nothing
about native child-stop behavior.

Lean 4.35.0 exited 0 with axiom output `[propext]` and no unfinished proof.
TLC 2.19 exited 12 for the intended legacy counterexample and 0 for the fixed
model. Each explored three distinct states at depth 3; the fixed queue was
empty. Runtime regressions separately cover all three selectors and preserve
the primary staged state, while the model's index routing uses only the first.

Run from the repository root with cached tools:

```sh
/private/tmp/phi-lean-4.35.0/lean-4.35.0-darwin_aarch64/bin/lean verification/lean/GitContext.lean
legacy_meta=$(mktemp -d /private/tmp/phi-git-context-legacy.XXXXXX)
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir "$legacy_meta" -config verification/tla/git-context/legacy.cfg verification/tla/git-context/GitContext.tla
fixed_meta=$(mktemp -d /private/tmp/phi-git-context-fixed.XXXXXX)
java -XX:+UseParallelGC -cp /private/tmp/tla2tools-v1.7.4.jar tlc2.TLC -workers 1 -metadir "$fixed_meta" -config verification/tla/git-context/fixed.cfg verification/tla/git-context/GitContext.tla
```
