---------------- MODULE ControlPicker ----------------
EXTENDS TLC

CONSTANT GuardPickerToken
ASSUME GuardPickerToken \in BOOLEAN

VARIABLES requestCurrent, sessionCurrent, validationPending, nativeIssued,
          requestCurrentAtValidationReturn, acknowledged, selection
vars == <<requestCurrent, sessionCurrent, validationPending, nativeIssued,
          requestCurrentAtValidationReturn, acknowledged, selection>>

Init == /\ requestCurrent = TRUE /\ sessionCurrent = TRUE
        /\ validationPending = TRUE /\ nativeIssued = FALSE
        /\ requestCurrentAtValidationReturn = FALSE
        /\ acknowledged = FALSE /\ selection = "original"

Escape == /\ requestCurrent /\ requestCurrent' = FALSE
          /\ UNCHANGED <<sessionCurrent, validationPending, nativeIssued,
                          requestCurrentAtValidationReturn, acknowledged, selection>>
CanIssue == sessionCurrent /\ (~GuardPickerToken \/ requestCurrent)
ValidationReturns == /\ validationPending /\ validationPending' = FALSE
                     /\ nativeIssued' = CanIssue
                     /\ requestCurrentAtValidationReturn' = requestCurrent
                     /\ UNCHANGED <<requestCurrent, sessionCurrent, acknowledged, selection>>
ReplaceSession == /\ sessionCurrent /\ sessionCurrent' = FALSE
                 /\ requestCurrent' = FALSE /\ selection' = "replacement"
                 /\ UNCHANGED <<validationPending, nativeIssued, requestCurrentAtValidationReturn,
                                 acknowledged>>
NativeAck == /\ nativeIssued /\ ~acknowledged /\ acknowledged' = TRUE
            /\ selection' = (IF sessionCurrent THEN "modelA" ELSE selection)
            /\ requestCurrent' = requestCurrent
            /\ sessionCurrent' = sessionCurrent
            /\ validationPending' = validationPending
            /\ nativeIssued' = nativeIssued
            /\ requestCurrentAtValidationReturn' = requestCurrentAtValidationReturn

Hold == UNCHANGED vars
Next == Escape \/ ValidationReturns \/ ReplaceSession \/ NativeAck \/ Hold
Spec == Init /\ [][Next]_vars

TypeOK == /\ requestCurrent \in BOOLEAN /\ sessionCurrent \in BOOLEAN
          /\ validationPending \in BOOLEAN /\ nativeIssued \in BOOLEAN
          /\ requestCurrentAtValidationReturn \in BOOLEAN /\ acknowledged \in BOOLEAN
          /\ selection \in {"original", "replacement", "modelA"}
NoIssueAfterCancel == ~nativeIssued \/ requestCurrentAtValidationReturn
NoStaleAckUpdate == sessionCurrent \/ selection = "replacement"
======================================================================
