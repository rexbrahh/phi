import Std

namespace ShellPreviewProof

def limit : Nat := 8192

structure Chunk where
  units : Nat
  splitPairAtCut : Bool
  deriving DecidableEq, Repr

structure AppendResult where
  prefixLength : Nat
  truncated : Bool
  notified : Bool
  deriving DecidableEq, Repr

structure State where
  prefixLength : Nat
  truncated : Bool
  visibleTruncated : Bool
  chunks : List Chunk
  deriving DecidableEq, Repr

def appendPreview (fixed : Bool) (priorLength : Nat) (truncated : Bool)
    (chunk : Chunk) : AppendResult :=
  if fixed && (truncated || chunk.units == 0) then
    ⟨priorLength, truncated, false⟩
  else if chunk.units == 0 then
    ⟨priorLength, truncated, false⟩
  else
    let remaining := limit - priorLength
    if chunk.units ≤ remaining then
      ⟨priorLength + chunk.units, truncated, true⟩
    else
      let kept := if chunk.splitPairAtCut then remaining - 1 else remaining
      ⟨priorLength + kept, true, fixed || kept > 0⟩

def step (fixed : Bool) (s : State) : State :=
  match s.chunks with
  | [] => s
  | chunk :: rest =>
      let result := appendPreview fixed s.prefixLength s.truncated chunk
      { s with
        prefixLength := result.prefixLength
        truncated := result.truncated
        visibleTruncated := if result.notified then result.truncated else s.visibleTruncated
        chunks := rest }

def invariant (s : State) : Prop :=
  s.prefixLength ≤ limit ∧ (s.truncated = true → s.visibleTruncated = true)

def initial (chunks : List Chunk) : State := ⟨0, false, false, chunks⟩

def runChunks (fixed : Bool) (s : State) : List Chunk → State
  | [] => s
  | _ :: rest => runChunks fixed (step fixed s) rest

theorem initialInvariant (chunks : List Chunk) : invariant (initial chunks) := by
  simp [invariant, initial, limit]

theorem fixedAppendPrefixBounded (priorLength : Nat) (truncated : Bool)
    (chunk : Chunk) (hprefix : priorLength ≤ limit) :
    (appendPreview true priorLength truncated chunk).prefixLength ≤ limit := by
  unfold appendPreview
  simp only [Bool.true_and]
  by_cases htruncated : truncated = true
  · simp [htruncated]
    exact hprefix
  · by_cases hempty : chunk.units = 0
    · simp [htruncated, hempty]
      exact hprefix
    · by_cases hfits : chunk.units ≤ limit - priorLength
      · simp [htruncated, hempty, hfits]
        omega
      · cases chunk.splitPairAtCut <;> simp [htruncated, hempty, hfits] <;> omega

theorem fixedAppendVisible (priorLength : Nat) (truncated visible : Bool)
    (chunk : Chunk) (hvisible : truncated = true → visible = true) :
    (appendPreview true priorLength truncated chunk).truncated = true →
      (if (appendPreview true priorLength truncated chunk).notified
       then (appendPreview true priorLength truncated chunk).truncated else visible) = true := by
  unfold appendPreview
  simp only [Bool.true_and]
  by_cases htruncated : truncated = true
  · have hv := hvisible htruncated
    simp [htruncated, hv]
  · by_cases hempty : chunk.units = 0
    · simp [htruncated, hempty]
    · by_cases hfits : chunk.units ≤ limit - priorLength
      · simp [htruncated, hempty, hfits]
      · cases chunk.splitPairAtCut <;> simp [htruncated, hempty, hfits]

theorem fixedStepPreserves (s : State) (h : invariant s) :
    invariant (step true s) := by
  rcases s with ⟨priorLength, truncated, visible, chunks⟩
  rcases h with ⟨hprefix, hvisible⟩
  cases chunks with
  | nil => simpa [invariant, step] using And.intro hprefix hvisible
  | cons chunk rest =>
      have hbound := fixedAppendPrefixBounded priorLength truncated chunk hprefix
      have hflag := fixedAppendVisible priorLength truncated visible chunk hvisible
      simp only [invariant, step]
      exact ⟨hbound, hflag⟩

theorem fixedStepAfterTruncation (s : State) (h : s.truncated = true) :
    (step true s).truncated = true ∧ (step true s).prefixLength = s.prefixLength := by
  cases s with
  | mk priorLength truncated visible chunks =>
      have htruncated : truncated = true := by simpa using h
      subst truncated
      cases chunks <;> simp [step, appendPreview]

theorem fixedRunPreserves (s : State) (chunks : List Chunk) (h : invariant s) :
    invariant (runChunks true s chunks) := by
  induction chunks generalizing s with
  | nil => simpa [runChunks] using h
  | cons _ rest ih =>
      simpa [runChunks] using ih (step true s) (fixedStepPreserves s h)

theorem fixedRunAfterTruncation (s : State) (chunks : List Chunk)
    (h : s.truncated = true) :
    (runChunks true s chunks).truncated = true ∧
      (runChunks true s chunks).prefixLength = s.prefixLength := by
  induction chunks generalizing s with
  | nil =>
      constructor
      · simpa [runChunks] using h
      · rfl
  | cons _ rest ih =>
      simp only [runChunks]
      have hstep := fixedStepAfterTruncation s h
      rcases ih (step true s) hstep.1 with ⟨htruncated, hprefix⟩
      exact ⟨htruncated, hprefix.trans hstep.2⟩

theorem fixedFiniteTraceInvariant (chunks : List Chunk) :
    invariant (runChunks true (initial chunks) chunks) :=
  fixedRunPreserves (initial chunks) chunks (initialInvariant chunks)

#print axioms fixedFiniteTraceInvariant
#print axioms fixedRunAfterTruncation

end ShellPreviewProof
