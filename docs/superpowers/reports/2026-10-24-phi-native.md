# Native SDK acceptance

Date: 2026-10-25. Tested SDK: `0.3.310`. Tested CLI: `2.1.310`.

## Current result

Native SDK acceptance remains incomplete. The user requires an independent TUI control for each native Workflow child. Phi does not implement this control because the inspected SDK host has no route to the native child-stop callback.

Native settings, project instructions, Skill invocation, Workflow launch, and both phase/child identities have positive receipts. Runs 6 and 7 proved main input responded while two native children remained held and the Workflow remained nonterminal. Retained run 7 data also proves both `SubagentStop` callbacks, normal journal results, exact final assistant markers, and parent completion through the post-parallel phase. Same-query main continuation after that completion remains unverified; the mandatory child-stop control is still absent.

This finding applies to SDK `0.3.310` and CLI `2.1.310` checked on 2026-10-25. The [official package registry](https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk) and [SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.310) identify the checked SDK version. This report does not claim that every SDK version lacks this operation.

[SDK issue 518](https://github.com/anthropics/claude-agent-sdk-typescript/issues/518) requests access to the existing native child-scoped operation. It was posted with user authorization on 2026-10-25. The operation and its live acceptance remain open.

## Workflow-child control contract

The native CLI's Workflow `x` action calls its local `onSkipAgent` callback with `(workflowTaskId, agentId)`. The runtime uses that pair to find and abort one child controller with reason `user-skip`. The child reports a skipped result, and its `agent()` call returns `null`. `parallel()` waits for its sibling slots. This is the native child lifecycle that Phi must control and report.

The public SDK's `Query.stopTask(taskId)` uses a registered ID from `task_notification`. It sends `stop_task` for that ID. It does not call the Workflow callback. The [published SDK declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts#L3292-L3295) document the task identity and stopped notification. The [official Workflow guide](https://code.claude.com/docs/en/workflows#watch-the-run) documents the CLI's selected-agent `x` action. The inspected SDK and bridge expose no host route from Phi to the native `(workflowTaskId, agentId)` callback.

| Issue | Required correction | Direct evidence |
|---|---|---|
| Phi cannot invoke the native selected-child callback. | Keep this acceptance gate open until Phi can invoke the callback for the selected Workflow child through a supported host entry point. | The pinned CLI runtime trace uses `(workflowTaskId, agentId)` to abort one child controller. The inspected SDK and bridge expose no route to that callback. |
| `Query.stopTask()` has a different task identity and behavior. | Do not pass a Workflow `agentId` to `stopTask()`. Do not count a registered SDK task stop as a Workflow-child stop. | The SDK declaration ties `stopTask(taskId)` to a `task_notification` ID and a stopped notification. It does not accept the Workflow callback's identity pair. |
| A child stop must preserve native Workflow behavior. | Verify the selected child reports `skipped`, a sibling remains active and completes, the Workflow continues after `parallel()`, and main input continues. | The pinned CLI runtime marks the user-stopped child as skipped, resolves its `agent()` call to `null`, and awaits sibling slots. No live child-stop result is claimed here. |

A local Bash stop does not meet the TUI Workflow-child requirement. Do not invent a task-notification ID for a Workflow child. The control-2 result explicitly records `workflowChildStopClaimed=false`.

## Native controls evidence

| Run | Source and cap | Result |
|---|---|---|
| Attempt 7 | `aa9eea470ab0edb519f73a8b5ddbb9886bd82f2a`; $0.10 cap; $0.0046 SDK estimate | The Workflow tool returned success. Two distinct subagent-start hooks, matching journal identities, two pending Monitor calls, and two phase-start records establish concurrent lifecycles and phase metadata. Backgrounding returned an acknowledgement without positive Workflow-background evidence. Child stop and continuing-sibling gates did not pass. |
| Controls 1 | `3561fc3`; $0.05 cap; $0.003488 SDK estimate | Its recorded gates passed. The resume prompt revealed the marker, and the success receipt preceded cleanup. Do not use this run as genuine-recall or final-cleanup proof. |
| Controls 2 | `8b4fa7a4e7affdd1b52a7ea313bb12ccb17215f8`; $0.02 cap; $0.003502 SDK estimate | Passed route, edit, task registration, registered-task stop notification, signal-driven server termination, continued input, checkpoint dry-run, genuine resumed-marker recall, and query termination. No tool actions were denied. `workflowChildStopClaimed=false`. |
| Configuration 4 | `59fe84b`; $0.03 cap; $0.01115793 SDK estimate | Passed project settings and instruction markers, native Skill invocation, Workflow launch, two agent starts, two phase records, and two matching child journal IDs. No permission was denied. Neither Monitor barrier appeared before the work deadline. The query terminated once and met the total deadline. Backgrounding and continuation remain unverified. |
| Configuration 6 | `59fe84b`; $0.03 cap; $0.00778436 SDK estimate | Both native Monitor hooks stayed pending with exact inputs and journal-matched IDs while the main session answered. The Workflow remained nonterminal. After release, both commands exited 0, both children returned, and the parent completed both phases. The composite probe stopped at its stop-and-journal predicate. |
| Configuration 7 | `59fe84b`; $0.03 cap; $0.007396835 SDK estimate | Repeated native background-continuity evidence. Captured two matching `SubagentStart` and `SubagentStop` callbacks, with no event mismatch. The private predicate incorrectly required `result.phase` and timed out. Offline replay through the actual journal reader passed the corrected ID-based predicate. Phi's history reader found both exact final assistant markers. The native parent record reports `completed` and both phases. The original composite result remains incomplete because no later main prompt was sent. |

Controls 2 passed its recorded scope. It did not pass the mandatory Workflow-child stop. Earlier attempts 6 and 7 also failed that child-control gate. Attempt 7's `stopTask(agent_id)` call produced no matching stopped notification and did not prove sibling isolation.

## Required gates

- Verify the API route and accepted credential source. Check settings, skills, and hooks.
- Make one tool edit. Run two parallel Workflow agents and check phase metadata.
- Check backgrounding and registered SDK task stop with a real registered task ID.
- Independently stop each Workflow child from Phi's TUI. Confirm its native skipped result, a still-active sibling, sibling completion, and Workflow continuation.
- Check continued main input, session resume, checkpoint limits, and query termination.

The native Bash stop does not satisfy the fourth gate. No more paid Workflow-stop guess probes are planned. The latest budget ledger reports no active runs. Its SDK estimates are not a billing total. See the [v1 report](2026-10-24-phi-v1.md) for the full budget record.

Three later configuration probes on `b17508c` used one query and a $0.03 cap each. Native Skill invocation and the project settings hook produced positive evidence. Workflow launch remained incomplete: the callback included a nonempty `script` string that the private empty-script guard denied. No child started. All three queries terminated; their final costs are unreported, not zero. The fixtures remain preserved. This result does not establish backgrounding or continuation and does not change the child-stop blocker.

The private guard now supplies the exact owned Workflow source to the existing strict validator. Configuration 4 passed launch and identity gates without widening permission to arbitrary scripts. The retained traces then identified the fixture's output-limit and instruction-scope defects.

The later fixture review found a 256-token ceiling that truncated thinking before tool use and project instructions that incorrectly applied main-session setup restrictions to children. The private fixture now uses the existing 1,024-token ceiling and scopes instructions by role. These limits came from the private fixture.

Native Workflows launch asynchronously. The published `WorkflowOutput` identifies `local_workflow` as a registered background task. The public `backgroundTasks()` method targets foreground Bash and subagent tasks. The private probe now checks the actual native async launch and a successful main reply while both child hooks remain pending; it does not require a foreground control to return `true` for an already-background Workflow. See the [official Workflow guide](https://code.claude.com/docs/en/workflows).

Both later queries terminated once, met the total deadline, and preserved their fixtures. No further paid run is planned in this probe series. The original failed probe reports remain unchanged.

## Retained completion and history evidence

The native journal places `phase` on `started` records. Its `result` records identify the child with `agentId` and omit `phase`. The corrected private predicate obtains child IDs from the target phase's starts, then requires two distinct, nonfailed, nonnull results for those IDs. It rejects unknown IDs, duplicates, and explicit phase mismatches. The product reader already preserves this optional field correctly; no product change was needed.

Offline replay of run 7 found two valid results and no reader warnings. The actual `HistoryReader.agentMessages()` returned six messages for one child and seven for the other. Each final assistant text matched its assigned marker; user-message echoes were not accepted. The reader closed and its worker terminated. No API request was made for these reads.

The owned native run record has `status=completed`, two agents, and both the parallel and post-parallel phase titles. This establishes parent completion independently of the failed probe predicate. It does not establish a later main response: the original probe halted before sending that prompt. Full composite success remains open, and the original receipt has not been rewritten as a pass.
