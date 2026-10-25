import Std

namespace InteractionQueueProof

abbrev Allocation := Nat

structure State where
  nextAllocation : Allocation := 0
  active : Option Allocation := none
  settledCache : Option Allocation := none
  settledTokens : List Allocation := []
  resolveCalls : List Allocation := []
  closed : Bool := false
  deriving DecidableEq, Repr

def initial : State := {}

def Invariant (s : State) : Prop :=
  s.resolveCalls.Nodup ∧
  s.settledTokens = s.resolveCalls ∧
  (∀ token, token ∈ s.settledTokens → token < s.nextAllocation) ∧
  (∀ token, s.active = some token →
    token < s.nextAllocation ∧ token ∉ s.settledTokens) ∧
  (∀ token, s.settledCache = some token →
    token < s.nextAllocation ∧ token ∈ s.settledTokens) ∧
  (s.closed = true → s.active = none) ∧
  (s.active = none ∨ s.settledCache = none)

def allocate (s : State) : State :=
  if s.closed = false ∧ s.active = none ∧ s.settledCache = none then
    { s with
      nextAllocation := s.nextAllocation + 1
      active := some s.nextAllocation }
  else s

def settleToken (s : State) (token : Allocation) : State :=
  if token ∈ s.settledTokens then s
  else if s.active = some token then
    { s with
      active := none
      settledCache := some token
      settledTokens := token :: s.settledTokens
      resolveCalls := token :: s.resolveCalls }
  else s

def clearSlots (s : State) : State :=
  { s with active := none, settledCache := none }

def cancelPending (s : State) : State :=
  let cancelled := match s.active with
    | none => s
    | some token => settleToken s token
  clearSlots cancelled

def cancelAll (s : State) : State :=
  let cancelled := cancelPending s
  { cancelled with closed := true }

theorem allocate_preserves (s : State) (h : Invariant s) : Invariant (allocate s) := by
  by_cases hReady : s.closed = false ∧ s.active = none ∧ s.settledCache = none
  · rcases hReady with ⟨hOpen, hNoActive, hNoCache⟩
    simp [allocate, hOpen, hNoActive, hNoCache]
    rcases h with ⟨hNodup, hHistory, hSettledBound, hActiveBound,
      hCacheBound, hClosed, hDisjoint⟩
    have hFresh : s.nextAllocation ∉ s.settledTokens := by
      intro hMem
      exact Nat.lt_irrefl _ (hSettledBound s.nextAllocation hMem)
    simp only [Invariant]
    refine ⟨hNodup, hHistory, ?_, ?_, ?_, ?_, ?_⟩
    · intro token hMem
      exact Nat.lt_succ_of_lt (hSettledBound token hMem)
    · intro token hActive
      injection hActive with hToken
      subst token
      exact ⟨Nat.lt_succ_self _, hFresh⟩
    · intro token hCache
      simp at hCache
    · intro hClosedNow
      simp at hClosedNow
    · simp
  · simpa [allocate, hReady] using h

theorem settleToken_preserves (s : State) (token : Allocation)
    (h : Invariant s) : Invariant (settleToken s token) := by
  by_cases hSettled : token ∈ s.settledTokens
  · simpa [settleToken, hSettled] using h
  · by_cases hActive : s.active = some token
    · simp only [settleToken, hSettled, hActive, ↓reduceIte]
      rcases h with ⟨hNodup, hHistory, hSettledBound, hActiveBound,
        hCacheBound, hClosed, hDisjoint⟩
      have hTokenInfo := hActiveBound token hActive
      have hFresh : token ∉ s.resolveCalls := by
        rw [← hHistory]
        exact hSettled
      simp only [Invariant]
      refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
      · simp [List.nodup_cons, hFresh, hNodup]
      · simp [hHistory]
      · intro other hMem
        simp only [List.mem_cons] at hMem
        rcases hMem with hEq | hOld
        · subst other
          exact hTokenInfo.1
        · exact hSettledBound other hOld
      · intro other hNewActive
        simp at hNewActive
      · intro other hNewCache
        cases hNewCache
        exact ⟨hTokenInfo.1, by simp⟩
      · intro _
        trivial
      · simp
    · simpa [settleToken, hSettled, hActive] using h

theorem clearSlots_preserves (s : State) (h : Invariant s) :
    Invariant (clearSlots s) := by
  rcases h with ⟨hNodup, hHistory, hSettledBound, hActiveBound,
    hCacheBound, hClosed, hDisjoint⟩
  simp only [clearSlots, Invariant]
  refine ⟨hNodup, hHistory, hSettledBound, ?_, ?_, ?_, ?_⟩
  · intro token hNewActive
    simp at hNewActive
  · intro token hNewCache
    simp at hNewCache
  · intro _
    trivial
  · simp

theorem cancelPending_preserves (s : State) (h : Invariant s) :
    Invariant (cancelPending s) := by
  unfold cancelPending
  cases hActive : s.active with
  | none =>
      simpa [hActive] using clearSlots_preserves s h
  | some token =>
      simpa [hActive] using clearSlots_preserves (settleToken s token)
        (settleToken_preserves s token h)

theorem cancelPending_has_no_active (s : State) : (cancelPending s).active = none := by
  cases hActive : s.active <;> simp [cancelPending, clearSlots, hActive]

theorem cancelAll_preserves (s : State) (h : Invariant s) :
    Invariant (cancelAll s) := by
  have hCancelled := cancelPending_preserves s h
  rcases hCancelled with ⟨hNodup, hHistory, hSettledBound, hActiveBound,
    hCacheBound, hClosed, hDisjoint⟩
  have hNoActive := cancelPending_has_no_active s
  simp only [cancelAll, Invariant]
  refine ⟨hNodup, hHistory, hSettledBound, hActiveBound, hCacheBound, ?_, ?_⟩
  · intro _
    exact hNoActive
  · exact Or.inl hNoActive

inductive Step : State → State → Prop where
  | allocate (s : State) : Step s (allocate s)
  | settle (s : State) (token : Allocation) : Step s (settleToken s token)
  | cancelPending (s : State) : Step s (cancelPending s)
  | cancelAll (s : State) : Step s (cancelAll s)

inductive Reachable : State → Prop where
  | initial : Reachable initial
  | next {before after : State} : Reachable before → Step before after → Reachable after

theorem initial_invariant : Invariant initial := by
  simp [Invariant, initial]

theorem step_preserves {before after : State} (h : Invariant before)
    (step : Step before after) : Invariant after := by
  cases step with
  | allocate => exact allocate_preserves before h
  | settle token => exact settleToken_preserves before token h
  | cancelPending => exact cancelPending_preserves before h
  | cancelAll => exact cancelAll_preserves before h

theorem reachable_invariant {s : State} (h : Reachable s) : Invariant s := by
  induction h with
  | initial => exact initial_invariant
  | next _ step ih => exact step_preserves ih step

theorem nativePromise_resolves_at_most_once {s : State} (h : Reachable s) :
    s.resolveCalls.Nodup := (reachable_invariant h).1

theorem closed_queue_cannot_allocate {s : State} (h : Reachable s)
    (hClosed : s.closed = true) : (allocate s).active = none := by
  rcases reachable_invariant h with ⟨_, _, _, _, _, hClosedInvariant, _⟩
  have hNoActive := hClosedInvariant hClosed
  have hNoNewAllocation : allocate s = s := by
    simp [allocate, hClosed]
  simpa [hNoNewAllocation] using hNoActive

theorem settled_stale_action_is_noop (s : State) (token : Allocation)
    (hSettled : token ∈ s.settledTokens) : settleToken s token = s := by
  simp [settleToken, hSettled]

theorem settled_stale_action_preserves_current (s : State) (stale current : Allocation)
    (hSettled : stale ∈ s.settledTokens) (hCurrent : s.active = some current) :
    (settleToken s stale).active = some current := by
  rw [settled_stale_action_is_noop s stale hSettled]
  exact hCurrent

theorem reachable_stale_settled_action_preserves_current {s : State}
    (hReachable : Reachable s) (stale current : Allocation)
    (hStaleSettled : stale ∈ s.settledTokens)
    (hCurrent : s.active = some current) :
    stale ≠ current ∧ (settleToken s stale).active = some current := by
  rcases reachable_invariant hReachable with ⟨_, _, _, hActiveBound, _, _, _⟩
  have hCurrentUnsettled := (hActiveBound current hCurrent).2
  have hDifferent : stale ≠ current := by
    intro hEqual
    subst current
    exact hCurrentUnsettled hStaleSettled
  exact ⟨hDifferent,
    settled_stale_action_preserves_current s stale current hStaleSettled hCurrent⟩

#print axioms initial_invariant
#print axioms step_preserves
#print axioms reachable_invariant
#print axioms nativePromise_resolves_at_most_once
#print axioms closed_queue_cannot_allocate
#print axioms settled_stale_action_is_noop
#print axioms settled_stale_action_preserves_current
#print axioms reachable_stale_settled_action_preserves_current

end InteractionQueueProof
