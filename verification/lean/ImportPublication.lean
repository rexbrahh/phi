import Std

namespace ImportPublicationProof

inductive Target where
  | absent | existing | incomplete | complete
  deriving DecidableEq, Repr
inductive Phase where
  | needStage | staged | failed | retryStaged | merged | done
  deriving DecidableEq, Repr
inductive Action where
  | prepare | atomicLink | linkFailure | retryPrepare | publishMarker | hold
  deriving DecidableEq, Repr

structure State where
  target : Target
  initialTarget : Target
  phase : Phase
  attempt : Nat
  staged : Bool
  marker : Bool
  deriving DecidableEq, Repr

def initial (preexisting : Bool) : State :=
  let target := if preexisting then .existing else .absent
  ⟨target, target, .needStage, 0, false, false⟩

def Invariant (s : State) : Prop :=
  s.target ≠ .incomplete ∧
  (s.phase = .merged ∨ s.phase = .done →
    s.target = .existing ∨ s.target = .complete) ∧
  (s.marker = true → s.target = .existing ∨ s.target = .complete) ∧
  (s.initialTarget = .existing → s.target = .existing)

def step (s : State) : Action → State
  | .prepare =>
      if s.phase = .needStage ∧ s.attempt = 0 then
        { s with phase := .staged, attempt := 1, staged := true } else s
  | .atomicLink =>
      if (s.phase = .staged ∨ s.phase = .retryStaged) ∧ s.staged then
        if s.target = .absent then
          { s with target := .complete, phase := .merged, staged := false }
        else if s.target = .existing then
          { s with phase := .merged, staged := false } else s
      else s
  | .linkFailure =>
      if s.phase = .staged ∧ s.attempt = 1 ∧ s.target = .absent ∧ s.staged then
        { s with phase := .failed, staged := false } else s
  | .retryPrepare =>
      if s.phase = .failed ∧ s.attempt = 1 then
        { s with phase := .retryStaged, attempt := 2, staged := true } else s
  | .publishMarker =>
      if s.phase = .merged ∧ s.marker = false then
        { s with phase := .done, marker := true } else s
  | .hold => s

def run (s : State) : List Action → State
  | [] => s
  | action :: rest => run (step s action) rest

theorem initial_invariant (preexisting : Bool) : Invariant (initial preexisting) := by
  cases preexisting <;> simp [initial, Invariant]

theorem step_preserves (s : State) (action : Action) (h : Invariant s) :
    Invariant (step s action) := by
  cases action <;> simp [step, Invariant] <;> (repeat' split) <;> simp_all [Invariant]

theorem run_preserves (s : State) (actions : List Action) (h : Invariant s) :
    Invariant (run s actions) := by
  induction actions generalizing s with
  | nil => simpa [run] using h
  | cons action rest ih =>
      exact ih (step s action) (step_preserves s action h)

theorem fixedFiniteTraceInvariant (preexisting : Bool) (actions : List Action) :
    Invariant (run (initial preexisting) actions) :=
  run_preserves (initial preexisting) actions (initial_invariant preexisting)

#print axioms fixedFiniteTraceInvariant

end ImportPublicationProof
