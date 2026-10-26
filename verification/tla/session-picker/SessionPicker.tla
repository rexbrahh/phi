---------------- MODULE SessionPicker ----------------
EXTENDS Naturals, TLC

CONSTANTS ClearOnCancel, GuardPickerRequest
ASSUME ClearOnCancel \in BOOLEAN
ASSUME GuardPickerRequest \in BOOLEAN

VARIABLES pickerVisible, pickerEpoch, lookupPending, lookupFromPicker, lookupEpoch,
          pendingTransition, needsFreshConfirmation, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop
vars == <<pickerVisible, pickerEpoch, lookupPending, lookupFromPicker, lookupEpoch,
          pendingTransition, needsFreshConfirmation, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
Init == /\ pickerVisible = FALSE /\ pickerEpoch = 0
        /\ lookupPending = FALSE /\ lookupFromPicker = FALSE /\ lookupEpoch = 0
        /\ pendingTransition = FALSE /\ needsFreshConfirmation = FALSE
        /\ activeWork = TRUE /\ interruptCalls = 0
        /\ staleAuthorizationUsed = FALSE /\ stalePickerStop = FALSE

OpenPicker == /\ ~pickerVisible /\ pickerEpoch < 2
              /\ pickerVisible' = TRUE /\ pickerEpoch' = pickerEpoch + 1
              /\ pendingTransition' = FALSE
              /\ needsFreshConfirmation' = (needsFreshConfirmation \/ pendingTransition)
              /\ UNCHANGED <<lookupPending, lookupFromPicker, lookupEpoch, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
Escape == /\ pickerVisible /\ pickerVisible' = FALSE
          /\ pendingTransition' = (IF ClearOnCancel THEN FALSE ELSE pendingTransition)
          /\ needsFreshConfirmation' = (needsFreshConfirmation \/ pendingTransition)
          /\ UNCHANGED <<pickerEpoch, lookupPending, lookupFromPicker, lookupEpoch, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
ExpireConfirmation == /\ pendingTransition /\ pendingTransition' = FALSE
                      /\ needsFreshConfirmation' = TRUE
                      /\ UNCHANGED <<pickerVisible, pickerEpoch, lookupPending, lookupFromPicker, lookupEpoch, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>

PickerResume == /\ pickerVisible /\ ~lookupPending
                /\ lookupPending' = TRUE /\ lookupFromPicker' = TRUE
                /\ lookupEpoch' = pickerEpoch
                /\ UNCHANGED <<pickerVisible, pickerEpoch, pendingTransition, needsFreshConfirmation, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
DirectResume == /\ ~lookupPending /\ lookupPending' = TRUE
                /\ lookupFromPicker' = FALSE
                /\ UNCHANGED <<pickerVisible, pickerEpoch, lookupEpoch, pendingTransition, needsFreshConfirmation, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
PickerRequestCurrent == pickerVisible /\ lookupEpoch = pickerEpoch
RequestCurrent == ~lookupFromPicker \/ ~GuardPickerRequest \/ PickerRequestCurrent
MetadataReturns ==
  /\ lookupPending
  /\ lookupPending' = FALSE
  /\ IF RequestCurrent /\ activeWork /\ pendingTransition
        THEN /\ pendingTransition' = FALSE /\ activeWork' = FALSE
             /\ interruptCalls' = interruptCalls + 1
             /\ staleAuthorizationUsed' = (staleAuthorizationUsed \/ needsFreshConfirmation)
             /\ stalePickerStop' = (stalePickerStop \/
                   (lookupFromPicker /\ ~PickerRequestCurrent))
             /\ UNCHANGED <<pickerVisible, pickerEpoch, lookupFromPicker, lookupEpoch, needsFreshConfirmation>>
        ELSE IF RequestCurrent /\ activeWork
          THEN /\ pendingTransition' = TRUE /\ needsFreshConfirmation' = FALSE
               /\ UNCHANGED <<pickerVisible, pickerEpoch, lookupFromPicker, lookupEpoch, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>
          ELSE /\ UNCHANGED <<pickerVisible, pickerEpoch, lookupFromPicker, lookupEpoch, pendingTransition, needsFreshConfirmation, activeWork, interruptCalls, staleAuthorizationUsed, stalePickerStop>>

Hold == UNCHANGED vars
Next == OpenPicker \/ Escape \/ ExpireConfirmation \/ PickerResume \/ DirectResume \/ MetadataReturns \/ Hold
Spec == Init /\ [][Next]_vars

TypeOK == /\ pickerVisible \in BOOLEAN /\ pickerEpoch \in 0..2
          /\ lookupPending \in BOOLEAN /\ lookupFromPicker \in BOOLEAN /\ lookupEpoch \in 0..2
          /\ pendingTransition \in BOOLEAN /\ needsFreshConfirmation \in BOOLEAN
          /\ activeWork \in BOOLEAN /\ interruptCalls \in 0..1
          /\ staleAuthorizationUsed \in BOOLEAN /\ stalePickerStop \in BOOLEAN
FreshConfirmationRequired == ~staleAuthorizationUsed
NoStalePickerStop == ~stalePickerStop
====================================================================
