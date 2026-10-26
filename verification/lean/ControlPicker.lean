import Std

namespace ControlPickerProof

inductive Selection where
  | original | replacement | modelA
  deriving DecidableEq, Repr

inductive Action where
  | escape | validationReturns | replaceSession | acknowledge | hold
  deriving DecidableEq, Repr

structure State where
  requestCurrent : Bool
  sessionCurrent : Bool
  validationPending : Bool
  nativeIssued : Bool
  requestCurrentAtValidationReturn : Bool
  acknowledged : Bool
  selection : Selection
  deriving DecidableEq, Repr

def initial : State := ⟨true, true, true, false, false, false, .original⟩

def step (s : State) : Action → State
  | .escape => { s with requestCurrent := false }
  | .validationReturns =>
      if s.validationPending then
        let issued := s.requestCurrent && s.sessionCurrent
        { s with validationPending := false, nativeIssued := issued, requestCurrentAtValidationReturn := s.requestCurrent }
      else s
  | .replaceSession =>
      if s.sessionCurrent then
        { s with requestCurrent := false, sessionCurrent := false, selection := .replacement }
      else s
  | .acknowledge =>
      if s.nativeIssued && !s.acknowledged then
        let nextSelection := if s.sessionCurrent then .modelA else s.selection
        { s with acknowledged := true, selection := nextSelection }
      else s
  | .hold => s

def Safe (s : State) : Prop :=
  (s.nativeIssued = false ∨ s.requestCurrentAtValidationReturn = true) ∧
    (s.sessionCurrent = true ∨ s.selection = .replacement)

theorem initial_safe : Safe initial := by simp [Safe, initial]

theorem step_preserves (s : State) (action : Action) (h : Safe s) : Safe (step s action) := by
  cases action with
  | escape => simpa [Safe, step] using h
  | validationReturns =>
      by_cases pending : s.validationPending = true
      · cases req : s.requestCurrent <;> cases session : s.sessionCurrent <;>
          simp_all [Safe, step]
      · simpa [Safe, step, pending] using h
  | replaceSession =>
      simp only [step]
      split <;> simp_all [Safe]
  | acknowledge =>
      simp only [step]
      split
      · split <;> simp_all [Safe]
      · simpa [Safe] using h
  | hold => exact h

def run (s : State) : List Action → State
  | [] => s
  | action :: rest => run (step s action) rest

theorem run_preserves (s : State) (actions : List Action) (h : Safe s) :
    Safe (run s actions) := by
  induction actions generalizing s with
  | nil => simpa [run] using h
  | cons action rest ih => exact ih (step s action) (step_preserves s action h)

theorem every_trace_safe (actions : List Action) : Safe (run initial actions) :=
  run_preserves initial actions initial_safe

theorem stale_session_ack_preserves_selection (s : State) (h : s.sessionCurrent = false) :
    (step s .acknowledge).selection = s.selection := by
  simp only [step]
  split
  · simp [h]
  · rfl

#print axioms every_trace_safe
#print axioms stale_session_ack_preserves_selection

end ControlPickerProof
