---------------- MODULE ImportPublication ----------------
EXTENDS Naturals, TLC

CONSTANT Mode
ASSUME Mode \in {"legacy", "atomic"}

VARIABLES phase, attempt, staged, target, initialTarget, marker
vars == <<phase, attempt, staged, target, initialTarget, marker>>

Init == /\ phase = "needStage"
        /\ attempt = 0
        /\ staged = FALSE
        /\ initialTarget \in {"absent", "existing"}
        /\ target = initialTarget
        /\ marker = FALSE

PrepareFirst == /\ phase = "needStage" /\ attempt = 0
                /\ attempt' = 1 /\ staged' = TRUE /\ phase' = "staged"
                /\ UNCHANGED <<target, initialTarget, marker>>

LegacyOpenTarget == /\ Mode = "legacy" /\ phase = "staged"
                    /\ target = "absent" /\ staged
                    /\ target' = "partial" /\ phase' = "writing"
                    /\ UNCHANGED <<attempt, staged, initialTarget, marker>>
LegacyPostOpenFailure == /\ Mode = "legacy" /\ phase = "writing"
                          /\ target = "partial" /\ staged
                          /\ phase' = "failed" /\ staged' = FALSE
                          /\ UNCHANGED <<attempt, target, initialTarget, marker>>
RetryStage == /\ phase = "failed" /\ attempt = 1
             /\ attempt' = 2 /\ staged' = TRUE /\ phase' = "retryStaged"
             /\ UNCHANGED <<target, initialTarget, marker>>
LegacyRetrySkipsPartial == /\ Mode = "legacy" /\ phase = "retryStaged"
                           /\ target = "partial" /\ staged
                           /\ phase' = "retrySkipped" /\ staged' = FALSE
                           /\ UNCHANGED <<attempt, target, initialTarget, marker>>
LegacySkipsExisting == /\ Mode = "legacy" /\ phase = "staged"
                       /\ target = "existing" /\ phase' = "merged"
                       /\ staged' = FALSE
                       /\ UNCHANGED <<attempt, target, initialTarget, marker>>

AtomicLink == /\ Mode = "atomic" /\ phase \in {"staged", "retryStaged"}
              /\ staged /\ target \in {"absent", "existing"}
              /\ target' = IF target = "absent" THEN "complete" ELSE "existing"
              /\ phase' = "merged" /\ staged' = FALSE
              /\ UNCHANGED <<attempt, initialTarget, marker>>
AtomicLinkFailure == /\ Mode = "atomic" /\ phase = "staged"
                     /\ attempt = 1 /\ target = "absent" /\ staged
                     /\ phase' = "failed" /\ staged' = FALSE
                     /\ UNCHANGED <<attempt, target, initialTarget, marker>>

PublishMarker == /\ phase \in {"merged", "retrySkipped"} /\ ~marker
                 /\ marker' = TRUE /\ phase' = "done"
                 /\ UNCHANGED <<attempt, staged, target, initialTarget>>
CompletedHold == /\ marker /\ UNCHANGED vars

Next == PrepareFirst \/ LegacyOpenTarget \/ LegacyPostOpenFailure \/ RetryStage
        \/ LegacyRetrySkipsPartial \/ LegacySkipsExisting \/ AtomicLink
        \/ AtomicLinkFailure \/ PublishMarker \/ CompletedHold
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"needStage", "staged", "writing", "failed",
                         "retryStaged", "retrySkipped", "merged", "done"}
         /\ attempt \in 0..2 /\ staged \in BOOLEAN
         /\ target \in {"absent", "existing", "partial", "complete"}
         /\ initialTarget \in {"absent", "existing"} /\ marker \in BOOLEAN
NoIncompleteCompletion == marker => target \in {"existing", "complete"}
AtomicPublicationIsWhole == Mode = "legacy" \/ target # "partial"
PreservePreexistingContent == initialTarget = "existing" => target = "existing"
======================================================================
