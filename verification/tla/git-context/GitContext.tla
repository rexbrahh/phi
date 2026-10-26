---------------- MODULE GitContext ----------------
EXTENDS TLC

CONSTANT Mode
ASSUME Mode \in {"legacy", "fixed"}

VARIABLES phase, cwd, indexSelector, dirSelector, workTreeSelector,
          signing, ssh, selectedStaged, foreignStaged
vars == <<phase, cwd, indexSelector, dirSelector, workTreeSelector,
          signing, ssh, selectedStaged, foreignStaged>>

Init == /\ phase = "new" /\ cwd = "none"
        /\ indexSelector = TRUE /\ dirSelector = TRUE
        /\ workTreeSelector = TRUE
        /\ signing = TRUE /\ ssh = TRUE
        /\ selectedStaged = FALSE /\ foreignStaged = FALSE

Launch == /\ phase = "new"
          /\ phase' = "ready" /\ cwd' = "selected"
          /\ indexSelector' = IF Mode = "fixed" THEN FALSE ELSE indexSelector
          /\ dirSelector' = IF Mode = "fixed" THEN FALSE ELSE dirSelector
          /\ workTreeSelector' = IF Mode = "fixed" THEN FALSE ELSE workTreeSelector
          /\ UNCHANGED <<signing, ssh, selectedStaged, foreignStaged>>

GitAdd == /\ phase = "ready" /\ cwd = "selected"
          /\ phase' = "done"
          /\ IF indexSelector
                THEN /\ foreignStaged' = TRUE
                     /\ selectedStaged' = selectedStaged
                ELSE /\ selectedStaged' = TRUE
                     /\ foreignStaged' = foreignStaged
          /\ UNCHANGED <<cwd, indexSelector, dirSelector, workTreeSelector,
                         signing, ssh>>

DoneHold == /\ phase = "done" /\ UNCHANGED vars
Next == Launch \/ GitAdd \/ DoneHold
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"new", "ready", "done"}
          /\ cwd \in {"none", "selected"}
          /\ indexSelector \in BOOLEAN /\ dirSelector \in BOOLEAN
          /\ workTreeSelector \in BOOLEAN /\ signing \in BOOLEAN
          /\ ssh \in BOOLEAN /\ selectedStaged \in BOOLEAN
          /\ foreignStaged \in BOOLEAN
SelectorsCleared == phase = "new" \/
  (~indexSelector /\ ~dirSelector /\ ~workTreeSelector)
PreserveForeignStaging == ~foreignStaged
GitAddUsesSelectedContext == phase # "done" \/
  (cwd = "selected" /\ selectedStaged)
PreserveSigningAndSSH == signing /\ ssh
======================================================================
