# Conservative native acceptance attempt

Date: 2026-10-24. Source: `40741182ad6de93b9595534f40fbbc04a462a9f6`.

The native fixture failed while waiting for a Workflow launch result. Native acceptance remains incomplete. This attempt did not establish a production Workflow defect or its cause.

## Cost and credentials

The user requested the cheapest Anthropic API model and conservative use of the saved key. Current official pricing and an authenticated Models API response identified `claude-haiku-5-5` as the cheapest active model available to the account. Model discovery submitted no inference request.

The fixture pins that model for its initial query, resume, and both Workflow children. It accepts a total SDK budget of at most $0.10, bounds output and turns, disables API retries, and configures no model fallback. The key entered only the child environment. A private wrapper redacted captured output before saving it.

The latest observed SDK `total_cost_usd` was **$0.0050**. This is an SDK estimate, not a billing statement or remaining-credit balance. The result model-usage assertions were not reached. A configured SDK budget does not guarantee a hard billing stop for in-flight requests.

## Actual result

The attempt ran from 23:42:15 to 23:45:15 UTC and exited with status 1. Its diagnostic was:

> Timed out waiting for native Workflow launch result; latest total_cost_usd=$0.0050 USD; cleanup termination observed=yes

The outer 240-second watchdog did not fire. The fixture observed SDK query termination and removed its disposable workspace. No imported user hooks or customizations ran. No paid rerun followed this failure.

| Gate | Evidence | Result |
| --- | --- | --- |
| Native API route and key source | Their assertions precede the reached Workflow wait. | Passed for the initial session. |
| Fixture skill discovery | The initialized-command assertion precedes the reached wait. | Passed. Skill execution was not yet asserted. |
| Bash background control and named Workflow request | Exact-call, task/background, and named Workflow-input assertions precede the reached wait. | Passed for the synthetic command and exact named tool request. |
| Workflow launch | The required launch result did not arrive before the deadline. | Failed. The cause remains unverified. |
| Remaining native checks | Later result/model, edit/hook, parallel-child/phase, stop, continuation, resume, and checkpoint assertions were not reached. | Incomplete. |

## Offline evidence

The combined build and 21 focused checks passed before this run. Tests cover the budget refusal, pinned model declarations, query-creation tripwire, bounded/redacted failure diagnostics, session lifecycle, and app diagnostic redaction. They use synthetic keys.

All four source commits have signature headers. Each changes fewer than 400 added-plus-deleted lines. The latest source adds no production model default or user configuration change.

The SDK documents its tool list at turn start, so pre-prompt tool availability was not established. The native failure log preserves the wait label, observed cost, and termination result. It does not preserve the original model output or full tool events. Those missing observations limit diagnosis.

The offline investigation found no proven request or result-projection mismatch in the pinned SDK types. The exact named Workflow request was observed, but its result was not retained. No causal production fix is justified by this evidence.

Follow-up source `1982fd5f52f8d42d91b95e403f69c1deb2ab86cf` adds one bounded failure-only Workflow summary. It correlates the result internally, reports safe shape/status/model metadata, and redacts any short tool-error excerpt. It excludes prompts and identifier/path values. Build, typecheck, and 15 focused offline tests passed. No second native attempt ran during this work.

The instrumented follow-up used the same cheapest model with a $0.02 SDK budget to capture the missing result evidence. Required native assertions remain intact. Ghostty acceptance also remains pending because the user has not opened Phi yet.

## Second authorized attempt

The user authorized one additional attempt with a $0.02 SDK budget. Source `be105b07aa479eaccfb197718f12b3c001bfacb6` ran from 00:05:37 to 00:08:38 UTC on 2026-10-25. It exited with status 1. Query termination was observed, and the outer watchdog did not fire.

The summary correlated the exact named Workflow call with a tool result carrying `is_error=true`. Its error excerpt was:

> The live fixture denied an unlisted tool action.

That text originates in the fixture's permission callback. The assistant request had only the expected `name` key. The callback's actual input shape was not retained, so the exact reason for its denial remains unverified. The evidence identifies a fixture permission denial rather than a proven SDK Workflow implementation defect.

The latest model-result subtype was `success`, and its reported model usage contained only `claude-haiku-5-5`. This establishes the reported main-session model, not successful Workflow execution. Later native acceptance assertions were not reached.

The second attempt's latest observed SDK cost was **$0.0052**. The two reported estimates sum to **$0.0102**. This sum does not establish actual billing or a remaining credit balance. No further paid attempt is authorized by the user's one-attempt approval.

Offline source inspection and a direct callback regression confirm that the exact `{name}` request is allowed. The SDK wrapper passes its control-request fields to the callback without normalizing them. The actual denied callback name and input were not retained, so a causal permission correction remains unsupported.

Source `24ca1944649f98985caf215a5be3e0aa75f0823b` preserves all allow/deny rules and adds a failure-only summary of at most three denied actions. It records sanitized tool names, input key names, and fixed rejection reasons. It excludes input values and credentials. Build, typecheck, and 17 focused checks passed with synthetic inputs. No further paid run was performed.

Required native assertions and Ghostty acceptance remain open. The next diagnostic run requires further authorization.

Primary references: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [SDK dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows), and [runtime environment variables](https://code.claude.com/docs/en/env-vars).
