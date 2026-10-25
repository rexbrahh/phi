---------------- MODULE StartupReplyCapture ----------------
EXTENDS Naturals, TLC

CONSTANTS NoPending, CsiQuestion
ASSUME NoPending = "none" /\ CsiQuestion = "CSI?"

VARIABLES capture, pending, prefixSeen, editorHasReplyByte,
          replyComplete, ordinaryText, keyActions
vars == <<capture, pending, prefixSeen, editorHasReplyByte,
          replyComplete, ordinaryText, keyActions>>

Init == /\ capture = TRUE
        /\ pending = NoPending
        /\ prefixSeen = FALSE
        /\ editorHasReplyByte = FALSE
        /\ replyComplete = FALSE
        /\ ordinaryText = FALSE
        /\ keyActions = 0

(* Source map: captureStartupTerminalReply recognizes ESC[? and
   holdStartupTerminalReply retains it. *)
HoldQuestionPrefix == /\ capture
                      /\ pending = NoPending
                      /\ pending' = CsiQuestion
                      /\ prefixSeen' = TRUE
                      /\ UNCHANGED <<capture, editorHasReplyByte,
                                     replyComplete, ordinaryText, keyActions>>

(* A 275 ms gap is a stuttering step: the corrected code has no expiry
   transition, so capture and pending remain unchanged. *)
ElapsedGap == /\ capture
              /\ pending = CsiQuestion
              /\ prefixSeen
              /\ UNCHANGED vars

(* Source map: captureStartupTerminalReply recognizes the completed
   Kitty reply, calls clearStartupTerminalReply, and returns consume. *)
LateReplyTail == /\ capture
                 /\ pending = CsiQuestion
                 /\ prefixSeen
                 /\ ~replyComplete
                 /\ pending' = NoPending
                 /\ replyComplete' = TRUE
                 /\ UNCHANGED <<capture, prefixSeen, editorHasReplyByte,
                                ordinaryText, keyActions>>

(* Source map: a standalone C0 byte clears a pending prefix, ends startup
   capture, then reaches onInput's existing Ctrl+C action branch. *)
ControlKeyAfterPrefix == /\ capture
                         /\ pending = CsiQuestion
                         /\ keyActions = 0
                         /\ capture' = FALSE
                         /\ pending' = NoPending
                         /\ keyActions' = 1
                         /\ UNCHANGED <<prefixSeen, editorHasReplyByte,
                                        replyComplete, ordinaryText>>

(* Source map: a printable event with no pending sequence ends capture and
   continues through the existing editor route. *)
OrdinaryPrintable == /\ capture
                     /\ pending = NoPending
                     /\ capture' = FALSE
                     /\ ordinaryText' = TRUE
                     /\ UNCHANGED <<pending, prefixSeen, editorHasReplyByte,
                                    replyComplete, keyActions>>

(* Source map: a complete unrelated key sequence with no pending sequence
   ends capture and continues through pi-tui key dispatch. *)
KeyboardAction == /\ capture
                   /\ pending = NoPending
                   /\ keyActions = 0
                   /\ capture' = FALSE
                   /\ keyActions' = 1
                   /\ UNCHANGED <<pending, prefixSeen, editorHasReplyByte,
                                  replyComplete, ordinaryText>>

Next == HoldQuestionPrefix \/ ElapsedGap \/ LateReplyTail \/
        ControlKeyAfterPrefix \/ OrdinaryPrintable \/ KeyboardAction
Spec == Init /\ [][Next]_vars

OrdinaryRouting == /\ (ordinaryText => ~capture)
                   /\ (keyActions = 1 => ~capture)
                   /\ keyActions \in 0..1

ReplySafety == replyComplete => ~editorHasReplyByte
===================================================================
