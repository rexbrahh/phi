# Native SDK acceptance

Date: 2026-10-25. Tested SDK: `0.3.310`. Tested CLI: `2.1.310`.

## Current result

Native SDK acceptance remains incomplete. Attempts 6 and 7 failed the Workflow child-control gate. The evidence applies to the tested versions and Workflow path. It does not establish that every SDK version lacks an individual child-stop handle.

| Attempt | Source | Observed result |
|---|---|---|
| 6 | `006f7db56e95d154566e4c52dab861c82bf958a0` | Monitor had 0 allowed-action denials. The parent query recorded no `local_agent` task. Both agents returned a Monitor acknowledgement after about two seconds. |
| 7 | `aa9eea470ab0edb519f73a8b5ddbb9886bd82f2a` | Two `SubagentStart` hooks matched the journal. Two Monitor `PreToolUse` requests waited. `backgroundTasks()` returned true, but no `local_agent` task appeared. |

Attempt 7 passed its two-Workflow-agent setup checks. The diagnostic `stopTask(agent_id)` call resolved, but no matching `stopped` notification arrived. Cleanup aborted both Monitor waits. No `SubagentStop` event arrived, and the sibling was not pending. The fixture did not reach continued input, session resume, or checkpoint checks.

| Observed issue | Proposed fix | Direct evidence |
|---|---|---|
| The Workflow child ID was not a registered SDK task ID. The resolved stop call did not prove that one child stopped while its sibling continued. | None. Keep this acceptance gate open. Do not treat `agent_id`, a resolved call, or `backgroundTasks()` as proof of an individual stop. | The pinned `stopTask(taskId)` contract uses a task ID from `task_notification`. The parent query recorded `local_bash` and `local_workflow` tasks, but no `local_agent` task. It recorded no matching stopped notification or `SubagentStop` event. |

The pinned SDK types and runtime use `task_id` for `stop_task`. Workflow hook IDs, journal agent IDs, and SDK task IDs are separate values. No later SDK or CLI version was tested.

## Required gates

V1 still requires these native checks:

- Verify the API route and key source. Check settings, skills, and hooks.
- Make one tool edit. Run two parallel Workflow agents and check phase metadata.
- Check backgrounding and individual task stop while the sibling remains pending.
- Check continued input, session resume, and checkpoint limits.

A separate native-controls fixture is in preparation. Its live controls remain unverified. No repeat paid run of the same Workflow child-stop probe is planned.

Attempt 7 reported an SDK estimate of **$0.0046**. This is not a billing total. See the [v1 acceptance report](2026-10-24-phi-v1.md) for the combined estimate and authorization status.
