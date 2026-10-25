---------------- MODULE StartupReplyCapture ----------------
EXTENDS Naturals, TLC

CONSTANTS NoPending, CsiQuestion
ASSUME NoPending = "none" /\ CsiQuestion = "CSI?"

VARIABLES capture, pending, timerArmed, prefixSeen,
          editorHasReplyByte, replyComplete, ordinaryText, keyActions
vars == <<capture, pending, timerArmed, prefixSeen,
          editorHasReplyByte, replyComplete, ordinaryText, keyActions>>

Init == /\ capture = TRUE
        /\ pending = NoPending
        /\ timerArmed = FALSE
        /\ prefixSeen = FALSE
        /\ editorHasReplyByte = FALSE
        /\ replyComplete = FALSE
        /\ ordinaryText = FALSE
        /\ keyActions = 0

(* Source map: captureStartupTerminalReply accepts ESC[? as a prefix and
   holdStartupTerminalReply stores it with the 250 ms timer armed. *)
HoldQuestionPrefix == /\ capture
                      /\ pending = NoPending
                      /\ pending' = CsiQuestion
                      /\ timerArmed' = TRUE
                      /\ prefixSeen' = TRUE
                      /\ UNCHANGED <<capture, editorHasReplyByte,
                                     replyComplete, ordinaryText, keyActions>>

(* Source map: timer callback disarms capture, clears pending, and sends
   pending.slice(2) == "?" directly to editor.handleInput. *)
ExpirePrefix == /\ capture
                /\ pending = CsiQuestion
                /\ timerArmed
                /\ capture' = FALSE
                /\ pending' = NoPending
                /\ timerArmed' = FALSE
                /\ editorHasReplyByte' = TRUE
                /\ UNCHANGED <<prefixSeen, replyComplete, ordinaryText, keyActions>>

(* Source map: after capture is false, the remaining "7u" is returned to
   the normal TUI path; the whole stream is the known reply ESC[?7u. *)
LateReplyTail == /\ ~capture
                 /\ prefixSeen
                 /\ pending = NoPending
                 /\ ~timerArmed
                 /\ ~replyComplete
                 /\ replyComplete' = TRUE
                 /\ editorHasReplyByte' = TRUE
                 /\ UNCHANGED <<capture, pending, timerArmed, prefixSeen,
                                ordinaryText, keyActions>>

(* Source map: an ordinary printable event with no pending prefix disables
   capture and proceeds through the regular TUI/editor route. *)
OrdinaryPrintable == /\ capture
                      /\ pending = NoPending
                      /\ capture' = FALSE
                      /\ ordinaryText' = TRUE
                      /\ UNCHANGED <<pending, timerArmed, prefixSeen,
                                     editorHasReplyByte, replyComplete, keyActions>>

(* Source map: a complete recognized key sequence with no pending prefix
   disables capture and continues through TUI key-action dispatch. *)
KeyboardAction == /\ capture
                   /\ pending = NoPending
                   /\ capture' = FALSE
                   /\ keyActions' = keyActions + 1
                   /\ UNCHANGED <<pending, timerArmed, prefixSeen,
                                  editorHasReplyByte, replyComplete, ordinaryText>>

Next == HoldQuestionPrefix \/ ExpirePrefix \/ LateReplyTail \/
        OrdinaryPrintable \/ KeyboardAction
Spec == Init /\ [][Next]_vars

OrdinaryRouting == /\ (ordinaryText => ~capture)
                   /\ (keyActions = 1 => ~capture)
                   /\ keyActions \in 0..1

ReplySafety == replyComplete => ~editorHasReplyByte
===================================================================
