import Std

namespace SessionPickerProof
inductive Action where
  | openPicker | escape | expireConfirmation | pickerResume | directResume | metadataReturns
  deriving DecidableEq, Repr

structure State where
  pickerVisible : Bool
  pickerEpoch : Nat
  lookupPending : Bool
  lookupFromPicker : Bool
  lookupEpoch : Nat
  pendingConfirmation : Bool
  needsFreshConfirmation : Bool
  activeWork : Bool
  interruptCalls : Nat
  deriving DecidableEq, Repr
def initial : State := ⟨false, 0, false, false, 0, false, false, true, 0⟩
def requestCurrent (s : State) : Bool :=
  !s.lookupFromPicker || (s.pickerVisible && s.lookupEpoch == s.pickerEpoch)
def step (s : State) : Action → State
  | .openPicker =>
      if s.pickerVisible = false then
        { s with pickerVisible := true, pickerEpoch := s.pickerEpoch + 1, pendingConfirmation := false, needsFreshConfirmation := s.needsFreshConfirmation || s.pendingConfirmation }
      else s
  | .escape =>
      if s.pickerVisible = true then
        { s with pickerVisible := false, pendingConfirmation := false, needsFreshConfirmation := s.needsFreshConfirmation || s.pendingConfirmation }
      else s
  | .expireConfirmation =>
      if s.pendingConfirmation = true then { s with pendingConfirmation := false, needsFreshConfirmation := true } else s
  | .pickerResume =>
      if s.pickerVisible = true ∧ s.lookupPending = false then
        { s with lookupPending := true, lookupFromPicker := true, lookupEpoch := s.pickerEpoch }
      else s
  | .directResume =>
      if s.lookupPending = false then { s with lookupPending := true, lookupFromPicker := false } else s
  | .metadataReturns =>
      if s.lookupPending = false then s
      else if requestCurrent s = true then
        if s.activeWork = false then { s with lookupPending := false }
        else if s.pendingConfirmation = true then
          { s with lookupPending := false, pendingConfirmation := false, activeWork := false, interruptCalls := s.interruptCalls + 1 }
        else
          { s with lookupPending := false, pendingConfirmation := true, needsFreshConfirmation := false }
      else { s with lookupPending := false }

def Safe (s : State) : Prop :=
  s.pendingConfirmation = false ∨ s.needsFreshConfirmation = false

theorem initial_safe : Safe initial := by simp [Safe, initial]
theorem step_preserves (s : State) (action : Action) (h : Safe s) : Safe (step s action) := by
  cases action with
  | openPicker =>
      by_cases hOpen : s.pickerVisible = false
      · simp [step, hOpen, Safe]
      · simpa [step, hOpen] using h
  | escape =>
      by_cases hVisible : s.pickerVisible = true
      · simp [step, hVisible, Safe]
      · simpa [step, hVisible] using h
  | expireConfirmation =>
      by_cases hPending : s.pendingConfirmation = true
      · simp [step, hPending, Safe]
      · simpa [step, hPending] using h
  | pickerResume =>
      by_cases hRequested : s.pickerVisible = true ∧ s.lookupPending = false
      · simpa [step, hRequested, Safe] using h
      · simpa [step, hRequested, Safe] using h
  | directResume =>
      by_cases hRequested : s.lookupPending = false <;> simpa [step, hRequested, Safe] using h
  | metadataReturns =>
      by_cases hNoLookup : s.lookupPending = false
      · simpa [step, hNoLookup] using h
      · by_cases hRequest : requestCurrent s = true
        · by_cases hInactive : s.activeWork = false
          · simpa [step, hNoLookup, hRequest, hInactive, Safe] using h
          · by_cases hPending : s.pendingConfirmation = true
            · simp [step, hNoLookup, hRequest, hInactive, hPending, Safe]
            · simp [step, hNoLookup, hRequest, hInactive, hPending, Safe]
        · simpa [step, hNoLookup, hRequest, Safe] using h
theorem canceled_direct_resume_requires_another_confirmation (s : State)
    (hLookup : s.lookupPending = false)
    (hPending : s.pendingConfirmation = false)
    (hRequired : s.needsFreshConfirmation = true)
    (hActive : s.activeWork = true) :
    let afterStart := step s .directResume
    let afterReturn := step afterStart .metadataReturns
    afterStart.needsFreshConfirmation = true ∧
    afterReturn.interruptCalls = s.interruptCalls ∧
      afterReturn.pendingConfirmation = true ∧ afterReturn.needsFreshConfirmation = false := by
  simp [step, requestCurrent, hLookup, hPending, hRequired, hActive]
#print axioms step_preserves
#print axioms canceled_direct_resume_requires_another_confirmation

end SessionPickerProof
