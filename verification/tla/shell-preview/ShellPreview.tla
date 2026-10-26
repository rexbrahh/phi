-------------------- MODULE ShellPreview --------------------
EXTENDS Naturals, Sequences, TLC

CONSTANTS Mode, Scenario
ASSUME Mode \in {"legacy", "fixed"}
ASSUME Scenario \in {"exact", "split", "both"}

Limit == 8192
ExactChunks == << [units |-> Limit, splitPairAtCut |-> FALSE],
                 [units |-> 1, splitPairAtCut |-> FALSE],
                 [units |-> 1, splitPairAtCut |-> FALSE] >>
SplitChunks == << [units |-> Limit - 1, splitPairAtCut |-> FALSE],
                 [units |-> 2, splitPairAtCut |-> TRUE],
                 [units |-> 1, splitPairAtCut |-> FALSE] >>
Inputs == IF Scenario = "both" THEN {ExactChunks, SplitChunks}
          ELSE IF Scenario = "exact" THEN {ExactChunks} ELSE {SplitChunks}

VARIABLES prefixLength, truncated, visibleTruncated, chunks
vars == <<prefixLength, truncated, visibleTruncated, chunks>>

Init == /\ prefixLength = 0
        /\ truncated = FALSE
        /\ visibleTruncated = FALSE
        /\ chunks \in Inputs

Consume ==
  IF Len(chunks) = 0 THEN FALSE
  ELSE
    LET chunk == Head(chunks)
        units == chunk.units
        remaining == Limit - prefixLength
        splitEnd == IF chunk.splitPairAtCut THEN remaining - 1 ELSE remaining
        skip == Mode = "fixed" /\ (truncated \/ units = 0)
        fits == units <= remaining
        notify == IF skip \/ units = 0 THEN FALSE
                  ELSE IF fits THEN TRUE
                  ELSE IF Mode = "fixed" THEN TRUE ELSE splitEnd > 0
    IN /\ prefixLength' = IF skip \/ units = 0 THEN prefixLength
                           ELSE IF fits THEN prefixLength + units
                           ELSE prefixLength + splitEnd
       /\ truncated' = IF skip \/ units = 0 THEN truncated
                         ELSE IF fits THEN truncated ELSE TRUE
       /\ visibleTruncated' = IF notify THEN truncated' ELSE visibleTruncated
       /\ chunks' = Tail(chunks)

Done == chunks = <<>> /\ UNCHANGED vars
Next == Consume \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ prefixLength \in 0..Limit
          /\ truncated \in BOOLEAN
          /\ visibleTruncated \in BOOLEAN
PrefixBounded == prefixLength <= Limit
VisibleTruncation == truncated => visibleTruncated
PrefixFrozen == [][truncated => prefixLength' = prefixLength]_vars

==============================================================
