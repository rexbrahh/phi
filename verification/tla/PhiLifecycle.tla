---- MODULE PhiLifecycle ----
EXTENDS Naturals, FiniteSets

CONSTANTS
    Queries, SessionIds, RequestIds, Allocations, BackgroundTaskIds,
    NoQuery, NoSid, NoRequest, NoAllocation, InitialQuery,
    InitialSid, InitialBackground, CallbackGuard, MemoizedClose

Allocation(q, r) ==
    CASE q = "q0" /\ r = "r0" -> "a00"
      [] q = "q0" /\ r = "r1" -> "a01"
      [] q = "q1" /\ r = "r0" -> "a10"
      [] q = "q1" /\ r = "r1" -> "a11"

AllocationOwner(a) ==
    CASE a = "a00" -> "q0"
      [] a = "a01" -> "q0"
      [] a = "a10" -> "q1"
      [] a = "a11" -> "q1"

AllocationRequest(a) ==
    CASE a = "a00" -> "r0"
      [] a = "a10" -> "r0"
      [] OTHER -> "r1"

ASSUME
    /\ InitialQuery \in Queries /\ InitialSid \in SessionIds
    /\ InitialBackground \subseteq BackgroundTaskIds /\ NoQuery \notin Queries
    /\ NoSid \notin SessionIds /\ NoRequest \notin RequestIds
    /\ NoAllocation \notin Allocations /\ CallbackGuard \in BOOLEAN
    /\ MemoizedClose \in BOOLEAN

VARIABLES
    current, target, phase, retiring,
    queryStatus, querySid, visibleSid, callbackOwner,
    sessionError, activeByRequest, allocationStatus, allocationOwner,
    allocationRequest, settledRequests, closeRequested, nativeCloseCalls,
    backgroundTasks, backgroundAtEvent, interruptWitness

vars == <<
    current, target, phase, retiring,
    queryStatus, querySid, visibleSid, callbackOwner,
    sessionError, activeByRequest, allocationStatus, allocationOwner,
    allocationRequest, settledRequests, closeRequested, nativeCloseCalls,
    backgroundTasks, backgroundAtEvent, interruptWitness
>>

EmptyActive == [r \in RequestIds |-> NoAllocation]

SettleActive ==
    [a \in Allocations |->
        IF allocationStatus[a] = "active" THEN "settled" ELSE allocationStatus[a]]

Mark(event) ==
    /\ interruptWitness' = (event = "interrupt") /\ backgroundAtEvent' = backgroundTasks

Init ==
    /\ current = InitialQuery /\ target = NoQuery
    /\ phase = "running" /\ retiring = {}
    /\ queryStatus =
        [q \in Queries |-> IF q = InitialQuery THEN "open" ELSE "unused"]
    /\ querySid =
        [q \in Queries |-> IF q = InitialQuery THEN InitialSid ELSE NoSid]
    /\ visibleSid = InitialSid /\ callbackOwner = NoQuery
    /\ sessionError = "none" /\ activeByRequest = EmptyActive
    /\ allocationStatus = [a \in Allocations |-> "free"] /\ allocationOwner = [a \in Allocations |-> AllocationOwner(a)]
    /\ allocationRequest = [a \in Allocations |-> AllocationRequest(a)] /\ settledRequests = {}
    /\ closeRequested = [q \in Queries |-> FALSE] /\ nativeCloseCalls = [q \in Queries |-> 0]
    /\ backgroundTasks = InitialBackground /\ backgroundAtEvent = InitialBackground
    /\ interruptWitness = FALSE

Invalidate(nextQuery) ==
    /\ phase = "running" /\ current \in Queries
    /\ nextQuery \in Queries /\ queryStatus[nextQuery] = "unused"
    /\ target' = nextQuery /\ current' = NoQuery
    /\ phase' = "switching" /\ retiring' =
        IF queryStatus[current] \in {"open", "failed", "closing"}
        THEN retiring \cup {current}
        ELSE retiring
    /\ callbackOwner' = NoQuery /\ activeByRequest' = EmptyActive
    /\ allocationStatus' = SettleActive /\ settledRequests' = {}
    /\ UNCHANGED <<
        queryStatus, querySid, visibleSid, sessionError, allocationOwner,
        allocationRequest, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("invalidate")

CloseRequest(q) ==
    /\ q \in Queries /\ (q \in retiring \/ (q = current /\ queryStatus[q] = "failed") \/ closeRequested[q])
    /\ IF MemoizedClose /\ closeRequested[q]
       THEN UNCHANGED vars
       ELSE
           /\ nativeCloseCalls[q] < 2 /\ nativeCloseCalls' = [nativeCloseCalls EXCEPT ![q] = @ + 1]
           /\ closeRequested' = [closeRequested EXCEPT ![q] = TRUE] /\ queryStatus' =
                [queryStatus EXCEPT
                    ![q] = IF @ = "closed" THEN "closed" ELSE "closing"]
           /\ IF q = current
              THEN
                  /\ activeByRequest' = EmptyActive /\ allocationStatus' = SettleActive
                  /\ settledRequests' = {}
              ELSE
                  UNCHANGED <<activeByRequest, allocationStatus, settledRequests>>
           /\ UNCHANGED <<
               current, target, phase, retiring,
               querySid, visibleSid, callbackOwner, sessionError,
               allocationOwner, allocationRequest, backgroundTasks
               >>
           /\ Mark("close-request")

CloseComplete(q) ==
    /\ q \in Queries /\ closeRequested[q]
    /\ queryStatus[q] = "closing" /\ queryStatus' = [queryStatus EXCEPT ![q] = "closed"]
    /\ retiring' = retiring \ {q}
    /\ UNCHANGED <<
        current, target, phase, querySid, visibleSid,
        callbackOwner, sessionError, activeByRequest, allocationStatus, allocationOwner,
        allocationRequest, settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("close-complete")

OpenTarget(sid) ==
    /\ phase = "switching" /\ retiring = {}
    /\ target \in Queries /\ queryStatus[target] = "unused"
    /\ sid \in SessionIds /\ current' = target
    /\ target' = NoQuery /\ phase' = "running"
    /\ queryStatus' = [queryStatus EXCEPT ![target] = "open"] /\ querySid' = [querySid EXCEPT ![target] = sid]
    /\ visibleSid' = sid /\ callbackOwner' = NoQuery
    /\ sessionError' = "none"
    /\ UNCHANGED <<
        retiring, activeByRequest, allocationStatus, allocationOwner, allocationRequest,
        settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("open")

ResumeFailure ==
    /\ current \in Queries /\ phase = "running"
    /\ queryStatus[current] = "open" /\ queryStatus' = [queryStatus EXCEPT ![current] = "failed"]
    /\ sessionError' = "resume-failed" /\ callbackOwner' = current
    /\ UNCHANGED <<
        current, target, phase, retiring, querySid,
        visibleSid, activeByRequest, allocationStatus, allocationOwner, allocationRequest,
        settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("resume-failure")

OutputEnded ==
    /\ current \in Queries /\ phase = "running"
    /\ queryStatus[current] = "open" /\ queryStatus' = [queryStatus EXCEPT ![current] = "ended"]
    /\ sessionError' = "output-ended" /\ callbackOwner' = current
    /\ UNCHANGED <<
        current, target, phase, retiring, querySid,
        visibleSid, activeByRequest, allocationStatus, allocationOwner, allocationRequest,
        settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("output-ended")

MessageCallback(q, sid) ==
    /\ q \in Queries /\ queryStatus[q] # "unused"
    /\ sid \in SessionIds
    /\ IF q = current
       THEN
           /\ visibleSid' = sid /\ callbackOwner' = q
           /\ UNCHANGED <<
               current, target, phase, retiring, queryStatus,
               querySid, sessionError, activeByRequest, allocationStatus, allocationOwner,
               allocationRequest, settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
               >>
           /\ Mark("message-callback")
       ELSE IF CallbackGuard
            THEN UNCHANGED vars
            ELSE
                /\ visibleSid' = sid /\ callbackOwner' = q
                /\ UNCHANGED <<
                    current, target, phase, retiring, queryStatus,
                    querySid, sessionError, activeByRequest, allocationStatus, allocationOwner,
                    allocationRequest, settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
                    >>
                /\ Mark("stale-message-mutant")

ErrorCallback(q) ==
    /\ q \in Queries /\ queryStatus[q] # "unused"
    /\ IF q = current
       THEN
           /\ sessionError' = "sdk-error" /\ callbackOwner' = q
           /\ UNCHANGED <<
               current, target, phase, retiring, queryStatus,
               querySid, visibleSid, activeByRequest, allocationStatus, allocationOwner,
               allocationRequest, settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
               >>
           /\ Mark("error-callback")
       ELSE IF CallbackGuard
            THEN UNCHANGED vars
            ELSE
                /\ sessionError' = "sdk-error" /\ callbackOwner' = q
                /\ UNCHANGED <<
                    current, target, phase, retiring, queryStatus,
                    querySid, visibleSid, activeByRequest, allocationStatus, allocationOwner,
                    allocationRequest, settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
                    >>
                /\ Mark("stale-error-mutant")

RequestCallback(q, r, a) ==
    /\ q \in Queries /\ queryStatus[q] # "unused"
    /\ r \in RequestIds /\ a \in Allocations
    /\ a = Allocation(q, r) /\ activeByRequest[r] = NoAllocation
    /\ r \notin settledRequests /\ allocationStatus[a] = "free"
    /\ IF q = current
       THEN
           /\ activeByRequest' = [activeByRequest EXCEPT ![r] = a]
           /\ allocationStatus' = [allocationStatus EXCEPT ![a] = "active"]
           /\ allocationOwner' = [allocationOwner EXCEPT ![a] = q]
           /\ allocationRequest' = [allocationRequest EXCEPT ![a] = r] /\ callbackOwner' = q
           /\ UNCHANGED <<
               current, target, phase, retiring,
               queryStatus, querySid, visibleSid, sessionError,
               settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
               >>
           /\ Mark("request-callback")
       ELSE IF CallbackGuard
            THEN UNCHANGED vars
            ELSE
                /\ activeByRequest' = [activeByRequest EXCEPT ![r] = a]
                /\ allocationStatus' = [allocationStatus EXCEPT ![a] = "active"]
                /\ allocationOwner' = [allocationOwner EXCEPT ![a] = q]
                /\ allocationRequest' = [allocationRequest EXCEPT ![a] = r] /\ callbackOwner' = q
                /\ UNCHANGED <<
                    current, target, phase, retiring,
                    queryStatus, querySid, visibleSid, sessionError,
                    settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
                    >>
                /\ Mark("stale-request-mutant")

ResolveRequest(r) ==
    /\ r \in RequestIds /\ activeByRequest[r] \in Allocations
    /\ LET a == activeByRequest[r] IN
         /\ activeByRequest' = [activeByRequest EXCEPT ![r] = NoAllocation]
         /\ allocationStatus' = [allocationStatus EXCEPT ![a] = "settled"]
         /\ settledRequests' = settledRequests \cup {r}
         /\ UNCHANGED <<
             current, target, phase, retiring, queryStatus,
             querySid, visibleSid, callbackOwner, sessionError, allocationOwner,
             allocationRequest, closeRequested, nativeCloseCalls, backgroundTasks
             >>
         /\ Mark("request-resolved")

Interrupt ==
    /\ current \in Queries /\ phase = "running"
    /\ queryStatus[current] = "open"
    /\ UNCHANGED <<
        current, target, phase, retiring, queryStatus,
        querySid, visibleSid, callbackOwner, sessionError,
        activeByRequest, allocationStatus, allocationOwner, allocationRequest,
        settledRequests, closeRequested, nativeCloseCalls, backgroundTasks
        >>
    /\ Mark("interrupt")

BackgroundUpdate(q, tasks) ==
    /\ q \in Queries /\ queryStatus[q] # "unused"
    /\ tasks \subseteq BackgroundTaskIds
    /\ IF q = current
       THEN
           /\ backgroundTasks' = tasks /\ callbackOwner' = q
           /\ UNCHANGED <<
               current, target, phase, retiring, queryStatus,
               querySid, visibleSid, sessionError, activeByRequest, allocationStatus,
               allocationOwner, allocationRequest, settledRequests, closeRequested, nativeCloseCalls
               >>
           /\ Mark("background-update")
       ELSE IF CallbackGuard
            THEN UNCHANGED vars
            ELSE
                /\ backgroundTasks' = tasks /\ callbackOwner' = q
                /\ UNCHANGED <<
                    current, target, phase, retiring, queryStatus,
                    querySid, visibleSid, sessionError, activeByRequest, allocationStatus,
                    allocationOwner, allocationRequest, settledRequests, closeRequested, nativeCloseCalls
                    >>
                /\ Mark("stale-background-mutant")

Next ==
    \/ \E q \in Queries : Invalidate(q)
    \/ \E q \in Queries : CloseRequest(q)
    \/ \E q \in Queries : CloseComplete(q)
    \/ \E sid \in SessionIds : OpenTarget(sid)
    \/ ResumeFailure
    \/ OutputEnded
    \/ \E q \in Queries : ErrorCallback(q)
    \/ \E q \in Queries, sid \in SessionIds : MessageCallback(q, sid)
    \/ \E q \in Queries, r \in RequestIds, a \in Allocations : RequestCallback(q, r, a)
    \/ \E r \in RequestIds : ResolveRequest(r)
    \/ Interrupt
    \/ \E q \in Queries, tasks \in SUBSET BackgroundTaskIds : BackgroundUpdate(q, tasks)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ current \in Queries \cup {NoQuery} /\ target \in Queries \cup {NoQuery}
    /\ phase \in {"running", "switching"} /\ retiring \subseteq Queries
    /\ queryStatus \in [Queries -> {"unused", "open", "failed", "closing", "closed", "ended"}]
    /\ querySid \in [Queries -> SessionIds \cup {NoSid}] /\ visibleSid \in SessionIds
    /\ callbackOwner \in Queries \cup {NoQuery}
    /\ sessionError \in {"none", "resume-failed", "output-ended", "sdk-error"}
    /\ activeByRequest \in [RequestIds -> Allocations \cup {NoAllocation}]
    /\ allocationStatus \in [Allocations -> {"free", "active", "settled"}]
    /\ allocationOwner \in [Allocations -> Queries] /\ allocationRequest \in [Allocations -> RequestIds]
    /\ settledRequests \subseteq RequestIds /\ closeRequested \in [Queries -> BOOLEAN]
    /\ nativeCloseCalls \in [Queries -> 0..2] /\ backgroundTasks \subseteq BackgroundTaskIds
    /\ backgroundAtEvent \subseteq BackgroundTaskIds /\ interruptWitness \in BOOLEAN

CallbackStateOwned == callbackOwner = NoQuery \/ callbackOwner = current

RequestAllocationOwned ==
    \A r \in RequestIds :
        activeByRequest[r] = NoAllocation
        \/ /\ allocationOwner[activeByRequest[r]] = current
           /\ allocationRequest[activeByRequest[r]] = r /\ allocationStatus[activeByRequest[r]] = "active"

NativeCloseAtMostOnce ==
    \A q \in Queries : nativeCloseCalls[q] <= 1

InterruptPreservesBackground ==
    interruptWitness => backgroundAtEvent = backgroundTasks

====
