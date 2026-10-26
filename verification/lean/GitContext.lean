import Std

namespace GitContextProof

inductive Phase where
  | new | ready | done
  deriving DecidableEq, Repr

inductive Action where
  | launch | gitAdd | hold
  deriving DecidableEq, Repr

structure State where
  phase : Phase
  cwdSelected : Bool
  indexSelector : Bool
  dirSelector : Bool
  workTreeSelector : Bool
  signing : Bool
  ssh : Bool
  selectedStaged : Bool
  foreignStaged : Bool
  deriving DecidableEq, Repr

def initial : State :=
  ⟨.new, false, true, true, true, true, true, false, false⟩

def Invariant (s : State) : Prop :=
  s.foreignStaged = false ∧ s.signing = true ∧ s.ssh = true ∧
  (s.phase = .new ∨
    (s.cwdSelected = true ∧ s.indexSelector = false ∧
      s.dirSelector = false ∧ s.workTreeSelector = false)) ∧
  (s.phase = .done → s.selectedStaged = true)

def step (fixed : Bool) (s : State) : Action → State
  | .launch =>
      if s.phase = .new then
        let ready := { s with phase := .ready, cwdSelected := true }
        if fixed then
          { ready with indexSelector := false, dirSelector := false, workTreeSelector := false }
        else ready
      else s
  | .gitAdd =>
      if s.phase = .ready then
        if s.indexSelector then
          { s with phase := .done, foreignStaged := true }
        else { s with phase := .done, selectedStaged := true }
      else s
  | .hold => s

def run (s : State) : List Action → State
  | [] => s
  | action :: rest => run (step true s action) rest

theorem initialInvariant : Invariant initial := by
  simp [Invariant, initial]

theorem stepPreserves (s : State) (action : Action) (h : Invariant s) :
    Invariant (step true s action) := by
  cases action <;> simp [step, Invariant] at * <;> (repeat' split) <;> simp_all

theorem runPreserves (s : State) (actions : List Action) (h : Invariant s) :
    Invariant (run s actions) := by
  induction actions generalizing s with
  | nil => simpa [run] using h
  | cons action rest ih =>
      exact ih (step true s action) (stepPreserves s action h)

theorem fixedFiniteTraceInvariant (actions : List Action) :
    Invariant (run initial actions) :=
  runPreserves initial actions initialInvariant

#print axioms fixedFiniteTraceInvariant

end GitContextProof
