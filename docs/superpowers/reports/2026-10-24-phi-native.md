# Native SDK acceptance

Date: 2026-10-25. Tested SDK: `0.3.310`. Tested CLI: `2.1.310`.

## Current result

Native SDK acceptance remains incomplete. The user requires an independent TUI control for each native Workflow child. Phi does not implement this control because the inspected SDK host has no route to the native child-stop callback.

Native settings, project instructions, and Skill invocation have positive receipts. Workflow launch, two agent starts, and matching phase/journal identities also passed. Workflow-specific backgrounding and later continuation remain open.

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

Controls 2 passed its recorded scope. It did not pass the mandatory Workflow-child stop. Earlier attempts 6 and 7 also failed that child-control gate. Attempt 7's `stopTask(agent_id)` call produced no matching stopped notification and did not prove sibling isolation.

## Required gates

- Verify the API route and accepted credential source. Check settings, skills, and hooks.
- Make one tool edit. Run two parallel Workflow agents and check phase metadata.
- Check backgrounding and registered SDK task stop with a real registered task ID.
- Independently stop each Workflow child from Phi's TUI. Confirm its native skipped result, a still-active sibling, sibling completion, and Workflow continuation.
- Check continued main input, session resume, checkpoint limits, and query termination.

The native Bash stop does not satisfy the fourth gate. No more paid Workflow-stop guess probes are planned. The latest budget ledger reports no active runs. Its SDK estimates are not a billing total. See the [v1 report](2026-10-24-phi-v1.md) for the full budget record.

Three later configuration probes on `b17508c` used one query and a $0.03 cap each. Native Skill invocation and the project settings hook produced positive evidence. Workflow launch remained incomplete: the callback included a nonempty `script` string that the private empty-script guard denied. No child started. All three queries terminated; their final costs are unreported, not zero. The fixtures remain preserved. This result does not establish backgrounding or continuation and does not change the child-stop blocker.

The private guard now supplies the exact owned Workflow source to the existing strict validator. Configuration 4 passed launch and identity gates without widening permission to arbitrary scripts. Its later Monitor barrier timeout remains under offline investigation.
