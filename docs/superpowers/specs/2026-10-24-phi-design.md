# Phi design

Date: 2026-10-24. Status: v1 design. The user authorized implementation after final research and planning checks. No product code existed when this design was completed.

## Purpose and fixed decisions

Phi is a personal terminal coding agent with Claude Agent SDK as its backend and pi-tui as its terminal library.

The user wants to spend eligible Anthropic API credits while retaining the Claude Code experience they already value. They are not seeking a different agent harness. Their baseline includes native dynamic Workflows, subagents, worktrees, advanced Git operations, pull requests, and GitHub Actions.

Ghostty on macOS is the first acceptance target. Rex beta is the intended future terminal. Phi must remain a normal terminal application that can run in either environment.

The first implementation must support the complete development workflow. Visual polish can follow. Task visibility, cancellation, approvals, persistence, and keyboard reliability are functional requirements.

V1 means a complete local application that can start, perform the required work, recover its conversation, and exit correctly. It does not mean complete Claude Code feature parity. The implementation plan defines the exact boundary: [Phi v1 plan](../plans/2026-10-24-phi-v1.md).

The user supplied [rexbrahh/phi](https://github.com/rexbrahh/phi) as the upstream repository. It is public. Published examples and tests must contain no private session content.

Using the same harness is an architectural choice. Equal task quality and performance remain goals that require measurement.

## Approach

Build one TypeScript application. Use the public SDK to run Claude and pi-tui to present its state.

The backend and terminal library are user decisions. This design does not reopen them. Pi's complete interactive coding agent depends on its own agent-session runtime. It is not a generic frontend for an arbitrary backend. Phi therefore composes pi-tui components directly.

Phi owns input, rendering, dialogs, and views of SDK state. The SDK owns agent reasoning, tool execution, workflow execution, context management, and conversation persistence. Git and GitHub operations use the SDK's shell tools and the existing `git` and `gh` programs.

This boundary avoids a second scheduler, permission engine, Git automation engine, or conversation store. It also preserves the behavior that motivated the project.

Verified dependency candidates are `@anthropic-ai/claude-agent-sdk@0.3.310` and `@earendil-works/pi-tui@1.4.0`. The former pi-tui package name, `@mariozechner/pi-tui`, is deprecated. Pin the selected versions and commit a lockfile. The current pi-tui package requires Node 22.19 or later.

Sources: [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [pi-tui source](https://github.com/earendil-works/pi/tree/main/packages/tui), [Pi interactive mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts), [SDK package](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/0.3.310), [pi-tui package](https://registry.npmjs.org/@earendil-works%2fpi-tui/1.4.0).

## Evidence from the supplied session

The user supplied a private advanced coding session as the reference workload. The inspected files span several hours on 2026-10-24. They can continue to change.

Inspection covered the complete main conversation, canonical tool-call records across 159 linked agent transcripts, 16 workflow journals, and saved workflow scripts. Selected child outputs and failure paths received detailed inspection. Duplicate API request snapshots were excluded from tool counts. The inspected records contain more than 5,500 distinct tool calls and six main-session compactions. These are workload observations, not a benchmark of Phi.

| Observed issue or requirement | Proposed behavior | Evidence |
| --- | --- | --- |
| Work continues through many agents and changing requirements. | Keep the composer available. Show native task states and separate inspectors. | Five research agents followed by planning and critique at private reference record 425. One later journal contains 51 agent launches over time. |
| Workflows resume after partial completion and failures. | Preserve task, run, workflow, and tool IDs. Use native workflow resume semantics. | Workflow resume with `resumeFromRunId` at private reference record 4050. |
| Git work includes replay, splitting, signing, conflict repair, and per-commit verification. | Preserve complete shell arguments, results, failures, and environment. Let Claude use its native tools. | Signing failure at private reference record 1329. History and tree checks around line 5095. |
| Requirements arrive while background work and CI continue. | Distinguish submitted input from consumed input. Preserve drafts and show pending requests. | Corrections in queue records around private reference record 3923. |
| Model policy, effort, and workflow size change during the session. | Expose live controls backed by SDK APIs. Report effective settings. | Workflow-size change around private reference record 4825, then distinct models for audits and execution around line 4982. |

The study also found incorrect identifiers, invalid workflow code, overbroad failure heuristics, and misleading interpretations of failed tests. Phi must preserve the evidence needed to detect these mistakes. A successful tool call does not establish that the engineering decision was correct.

These files are private reference material. Do not copy the transcript, repository source, credentials, or API request bodies into test fixtures. Create synthetic fixtures that preserve the relevant event structure.

## SDK session contract

### Startup and configuration

Create one persistent `query()` connection with an open asynchronous input stream for each Phi process. Use the SDK's bundled runtime. Do not substitute an arbitrary globally installed Claude Code executable.

Run parallel interactive sessions in separate terminals. Within one Phi process, switching, clearing, or forking a session must not silently terminate background work. Require a deliberate stop-and-switch action while work remains. A session picker does not provide process detachment.

Set the `claude_code` system-prompt preset and the `claude_code` tool preset. Load user, project, and local settings. Preserve `CLAUDE_CONFIG_DIR` when the user sets it. Enable discovered skills through the SDK. Retain existing hooks, plugins, MCP servers, rules, and agent definitions through supported SDK configuration.

Current SDK defaults load filesystem settings. Older examples that describe isolation by default are stale. Explicit sources can document Phi's intended behavior. Do not clone the user's Claude configuration into a separate Phi configuration tree.

Use `includePartialMessages: true` and `forwardSubagentText: true`. Enable file checkpointing for the rewind feature. Enable `perTaskStopAffordance` only when the individual task-stop UI works and its tests pass.

Resolve API credentials through the user's existing environment or configured API-key helper. Never print or persist credential values. Check initialization account metadata before sending the first model prompt. If the effective provider or authentication does not match the intended Anthropic API route, show the mismatch and stop submission. Do not silently use a Claude subscription or another provider.

For the pinned SDK, accept provider `firstParty` with credential source `ANTHROPIC_API_KEY`, `apiKeyHelper`, or `/login managed key`. Reject `none`, legacy sources, and unknown sources. Stored Console keys are API credentials. This check does not prove which credit grant pays for usage.

Use the initialized runtime's tools, commands, models, capabilities, and configuration as the current authority. Do not maintain a fixed list of available models or tools. Preserve managed settings and SDK policy restrictions. Distinguish client-selected settings from SDK-reported effective values when the SDK supplies no live confirmation.

Sources: [system prompts and settings](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts), [published SDK declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts). Eligibility depends on the user's credits. [Anthropic documents the SDK distinction for eligible subscriber credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).

### Input and steering

Assign a UUID to each submitted message. Mark input from the human composer with `origin: { kind: "human" }`. This matters for native workflow activation. Preserve pasted-content boundaries and attachment types. Machine-generated notifications must retain their actual origin.

Leave native prompt processing enabled for ordinary human input. In particular, do not set `client_composed` globally. That flag changes slash-command, file-mention, and context-attachment behavior.

The composer stays usable during work and approvals. Forward submitted messages through the open SDK input stream. Let the SDK decide when it consumes them. Track local submission, SDK acknowledgement when available, and consumption separately. Use echoed UUIDs instead of guessing from the next assistant message.

Keep unsent drafts editable. Never display a submitted message as cancelled or removed without an SDK receipt. If queued-message editing is unavailable, preserve the original submission and offer a separate correction. An interrupt receipt can identify messages that will still run.

Support multiline editing, command and path completion, input history, bracketed paste, explicit file attachments, and image attachments. Reuse pi-tui editor and keyboard primitives. Verify clipboard-image input on macOS separately from image-file attachment.

Sources: [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [workflow activation](https://code.claude.com/docs/en/workflows), [SDK user-message fields](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts).

### Events and rendering state

Consume the SDK stream continuously. Keep event processing separate from redraw scheduling. A busy terminal must not delay permission responses or task control.

Use native session IDs, message UUIDs, tool-use IDs, task IDs, and run IDs as keys. Keep streamed blocks and final messages associated with their original message and content-block index. Final blocks reconcile provisional output. They do not append a second copy of the same text.

The SDK emits one complete assistant message per content block. Several envelopes can share `message.id`. Main-session deltas and complete subagent messages need separate handling. Apply `supersedes` and aborted-message metadata. Use `session_state_changed` for the session's running, idle, and requires-action states.

Separate the conversation view, task registry, submitted-input state, and pending dialogs. They share identifiers but have different lifetimes. Compaction changes model context without erasing task state or the user's visible history.

Treat `background_tasks_changed` as a complete replacement set. Reset this set when the SDK process starts again. Do not infer membership from event ordering. Exclude ambient watchers from the busy indicator. Keep terminal task outcomes available for inspection.

Reject stale task updates when a newer run ID is already visible. Use declared parent relationships when present. Workflow agents can lack `parent_task_id`. Do not manufacture a hierarchy from arrival order or text matching.

Preserve unknown event and tool types in an inspectable generic view. Do not discard them silently or label them successful. Render only model reasoning content actually supplied by the SDK.

Use existing pi-tui caching and incremental rendering. Cache completed blocks. Load old details on demand. Do not retain full duplicate transcripts for every subagent in memory. Bound previews while retaining access to complete SDK output.

Source: [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output). Event ordering, run IDs, and replacement semantics are specified in the [published declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts).

### Permissions, questions, and shutdown

Let SDK policy decide which actions need human input. `canUseTool` is not a notification for every tool invocation. Preserve session permission modes and policy results. Do not add blanket permission bypasses to reproduce historical behavior.

Render approval requests with the exact tool, arguments, affected paths, and SDK-provided choices. Render `AskUserQuestion` with its choices and free-text answer. Support MCP elicitation through its SDK callback. Queue concurrent dialogs without overwriting requests. Resolve each request once. Remove cancelled requests when their abort signal fires.

Use `onUserDialog` only for dialog kinds the UI actually implements. Advertise only those kinds. Unimplemented kinds keep the SDK's documented default behavior. Show permission denials and hook errors as such.

Separate three actions: interrupt the current turn, stop a selected task, and exit Phi. `query.interrupt()` stops the current turn. `query.stopTask(taskId)` stops a selected task. `query.close()` ends the process. Do not use process shutdown as a turn-stop shortcut.

With open input and `perTaskStopAffordance`, SDK interruption preserves background agents and workflows. The flag is a capability promise, not an optimization. Test it before enabling it.

On exit, show active work and obtain a deliberate stop-and-exit action when tasks remain. Restore terminal modes after normal exit, signals, startup failures, and uncaught errors. On a crash, retain the session ID and report that process-backed work may have stopped. Do not replay mutating tool calls automatically.

Sources: [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [interactive input](https://code.claude.com/docs/en/agent-sdk/user-input), [SDK interruption and dialog contract](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts).

## First implementation: workflow and development support

### Native Workflows and subagents

Expose the SDK's native `Workflow` and `Agent` tools without a restrictive replacement toolset. Preserve workflow scripts, structured outputs, task notifications, and native background execution.

The task inspector must show running, paused, failed, stopped, and completed work. Show the task description, identity, available progress, usage, output, and stop action. Open child conversations through forwarded messages and the SDK's session/subagent read APIs.

Preserve native workflow resume through `resumeFromRunId`. The SDK owns cached agent calls and resumed execution. Display the run identity so the user can inspect it and request a native resume. Do not implement a second replay mechanism.

The published SDK implementation recursively finds nested agent transcripts. Use `listSubagents()` and `getSubagentMessages()` for workflow agents as well as ordinary agents. Do not write another child-transcript parser.

Use one small read-only journal reader for phase labels and agent associations. Public task events do not expose the complete phase structure. The supplied session's journals contain `launched`, `started`, `result`, and `failed` records. Read the directory reported by the typed `WorkflowOutput`, after checking its session and configuration-root boundaries. Do not reconstruct configuration paths from project names.

Validate paths and records. Preserve incomplete trailing bytes until the next read. Unsupported formats make phase detail unavailable, while native tasks remain usable. Read journal metadata only. Never write, schedule, or resume work through this reader. Phase rows report observed agent calls, not a guessed percentage or future dependency graph.

Keep workflow `runId` separate from task-event `run_id`. The former identifies a resumable workflow journal. The latter orders executions of one task. The reference resumed the same workflow run under a different task ID.

### Worktrees, Git, and GitHub

Preserve native agent worktree isolation and the `EnterWorktree` / `ExitWorktree` tools. Show the active directory and known worktree association. Obtain repository state from the filesystem and Git, not model narration. Do not discard dirty worktrees or unmerged branches as part of cleanup.

Use the SDK's additive `CwdChanged` hook to update the active directory. Query Git at that directory. Keep the launch directory separately. Hook observation must not change tool permission decisions.

Claude must retain ordinary shell access to Git and `gh`. This covers branch graphs, rebase and cherry-pick operations, signed commits, conflict repair, worktree operations, pull requests, review threads, issues, and CI inspection. The agent chooses operations within the user's instructions and SDK permissions.

Preserve PATH, SSH-agent access, Git configuration, credential helpers, signing configuration, and repository hooks. Display real exit codes and stderr. A signing or sandbox error must remain visible. Phi must not automatically disable signing, weaken tests, or broaden sandbox permissions.

Tool cards must support long commands, diffs, structured tool results, background commands, output-file references, and links. Show the exact invocation separately from its summary. Keep complete output reachable when a preview is truncated.

Support explicit user shell commands, matching the reference session's `!` usage. The pinned public `Query` API has no direct shell-execution method. V1 therefore uses a local child process for this user action. Preserve cwd, environment, exit status, cancellation, and output. Append its result with `shouldQuery: false`, without fabricating model tool calls. Mark this generated context as machine-authored. Interactive child programs run in another terminal. Pasted text cannot select shell mode by itself.

Store large explicit-shell output in private files under the user's Phi state directory. These files contain output receipts, not a second conversation history. The guide must explain their location and retention. Do not delete them automatically when a session exits.

Git expertise depends on the model, harness, instructions, environment, and evidence. Phi can preserve these and test workflows. It cannot guarantee staff-level judgment through interface features alone.

Sources: [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [published tool schemas](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk-tools.d.ts). The local reference session establishes the required Git workflow scope.

## Terminal experience

Use pi-tui's main-screen mode for the proposed first layout. Preserve terminal scrollback, selection, and copying. Keep the composer and a compact status area below the conversation. Open task, output, session, and permission views only when needed.

The status area shows effective model and effort, permission mode, cwd or worktree, current activity, background task count, and available usage. Clearly label SDK-reported cost. It is not the user's remaining API-credit balance. Missing usage stays unknown instead of becoming zero.

Use the SDK's summary context query for routine status. Do not add model calls to generate UI progress summaries. Refresh repository status after relevant actions instead of repeatedly scanning every worktree. Distinguish the launch directory from a later SDK-reported working directory.

Use Markdown and code rendering from pi-tui. Collapse long tool output and completed task detail without hiding errors. Provide search, expansion, and copy actions. Do not make mouse support necessary for any action.

V1 uses Enter to submit and Shift+Enter or Ctrl+J for a newline. Escape dismisses completion or a view before it interrupts foreground work. Ctrl+B requests native backgrounding. Ctrl+T opens tasks. Ctrl+O opens the transcript inspector. Ctrl+Shift+P opens the command palette. Every view also has a command fallback.

The command palette combines supported SDK commands with local view controls. Native commands and skills retain native dispatch. Reserve `/phi` for local controls. They cover help, tasks, sessions, model/effort, permissions, context, worktrees, attachments, rewind, and exit. `/phi send <text>` forwards text literally, including a skill named `/phi`. Do not silently shadow other skills or advertise unsupported native commands.

Use SDK controls for live changes, including `setModel`, `setPermissionMode`, and `applyFlagSettings`. Session-only changes stay session-only unless the user explicitly requests persistence. Query model capabilities before displaying effort choices. Preserve the SDK's relationship between effort and ultracode settings.

Use SDK session listing and message APIs for resume. Preserve the original session when starting a new one or forking history. The SDK reads and parses complete transcript files before applying pagination. Run history reads in one Node worker so that this parsing does not occupy the terminal's event loop.

File rewind is separate from conversation resume. Enable user-message replay to receive checkpoint UUIDs. Preview affected files through supported checkpoint APIs before applying a rewind. The confirmation must state that checkpoints do not cover subagent edits and do not generally cover shell edits. Show skipped files and partial failures. Do not describe this feature as undoing the whole task.

Treat all model and tool text as untrusted terminal content. Do not pass arbitrary control sequences into the terminal. Trusted renderer formatting is separate from raw content. Keep credentials and environment values out of status, debug logs, and fixtures.

Sources: [pi-tui components and screen modes](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md), [SDK commands](https://code.claude.com/docs/en/agent-sdk/slash-commands), [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [checkpoint boundaries](https://code.claude.com/docs/en/agent-sdk/file-checkpointing), [published history implementation](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.mjs).

### Ghostty now, Rex later

Test keyboard decoding, paste, Unicode width, resize, scrolling, selection, and terminal restoration in Ghostty first. Use pi-tui's terminal capabilities instead of a Ghostty-specific input path.

Rex documents a CLI for sessions, windows, and terminal blocks. Preserve its inherited environment so tools can use it when the user runs Phi inside Rex. Do not require the CLI to start Phi. Do not create or rearrange Rex sessions automatically.

The pinned pi-tui already implements Rex's Program Status Protocol, OSC 7501. V1 calls `ProcessTerminal.setProgramStatus()` with generic activity states. Pi-tui owns capability detection and output. Do not add a Rex dependency, protocol encoder, or terminal-adapter framework. Disclose no prompt or tool content in status messages.

Rex's terminal-session lifetime and the SDK conversation lifetime are distinct. A terminal host may keep the Phi process alive when a client disconnects. Restarting Phi can resume conversation history but does not restore killed subprocesses or guarantee live workflow continuation.

The local check found no `rex` command on this shell's PATH and no Rex app at the two standard application paths. Beta behavior is not verified. Rex setup and migration are outside this implementation.

Sources: [Rex CLI and environment](https://www.superlogical.com/rex/docs/automate/cli), [Rex Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), [pi-tui status method](https://unpkg.com/@earendil-works/pi-tui@1.4.0/dist/terminal.d.ts).

## Known parity limits

| Requested capability or uncertainty | Current evidence | Design consequence |
| --- | --- | --- |
| Native dynamic Workflows | Official docs support them in the TypeScript SDK. Current schemas expose workflow execution and resume. | Include them in the first implementation. Verify execution, inspection, and interruption together. |
| Native agent-team teammates | Claude Code docs exclude SDK and other noninteractive sessions from teammate spawning. | Do not claim agent-team parity. Do not invent a replacement coordinator. |
| Cloud or Remote Control peer discovery with API-key auth | Cross-session messaging docs require Claude sign-in and Remote Control for cloud discovery. Local messaging is documented separately. | Preserve supported local behavior. Mark cloud peer discovery unavailable on the required API-key route. |
| Full workflow phase detail | Task events are public. Local journals contain phase labels. SDK history functions recursively read child transcripts. | Use SDK history plus the bounded journal reader. Report missing metadata explicitly. |
| Equal model quality, latency, and terminal behavior | No Phi implementation or live Phi benchmark exists yet. | Measure the first build. Keep framework tests separate from live model and terminal acceptance. |

Sources: [native Workflows](https://code.claude.com/docs/en/agent-sdk/subagents), [agent-team limitations](https://code.claude.com/docs/en/agent-teams), [cross-session messaging requirements](https://code.claude.com/docs/en/cross-session-messaging).

## Implementation boundaries

Keep the source structure small. The builder can adjust filenames without changing these responsibilities.

| Area | Responsibility | Direct checks |
| --- | --- | --- |
| CLI and session controller | Arguments, cwd, API-route check, query lifecycle, input, SDK controls, shutdown | Startup failure, unexpected exit, cancellation, auth mismatch, active-task exit |
| Event state | Message reconciliation, task states, input receipts, pending dialogs | Duplicate and late events, compaction, task replacement snapshots, concurrent prompts |
| Terminal views | Composer, transcript, tool output, dialogs, task/session inspectors, status | PTY interaction, resize, Unicode, paste, output bounds, terminal restoration |
| Commands and existing integrations | SDK commands and settings, session APIs, git/gh receipts, optional workflow artifact read | Command dispatch, native configuration discovery, worktree state, malformed artifacts |
| Project files and tests | Package metadata, lockfile, TypeScript config, executable entrypoint, user guide, synthetic fixtures | Type checking, focused unit tests, disposable integration tests, documented launch |

Use standard Node APIs and existing library components where they suffice. Do not add a provider abstraction, daemon, database, web frontend, plugin system, or workflow executor. No telemetry is required.

V1 excludes native agent-team replacement, cloud-peer replacement, multi-session process hosting, Rex automation, and visual customization beyond one readable terminal theme. It also excludes editing already-submitted messages without a public SDK cancellation API. Corrections remain normal follow-up messages.

## Validation and acceptance

### Deterministic checks

1. Reconcile streaming deltas, final messages, tool results, and replay without duplicated output. Include interrupted partial output and unknown events.
2. Exercise concurrent approvals, cancellation, late results, queued input receipts, and SDK process failure. Confirm that a decision reaches only its intended request.
3. Exercise task start, resume, progress, failure, completion, and replacement snapshots in varied orders. Confirm separate foreground interruption and task stop.
4. Replay synthetic workloads at least as large as the later reference snapshot: 7,000 tool calls and 200 child conversations. Measure input-to-render latency and memory growth.
5. Use a PTY to test startup, paste, keys, resize, and exit. Verify terminal restoration on failure. Keep private transcripts out of fixtures.

Proposed responsiveness target: p95 input-to-render latency below 50 ms during synthetic streaming on the user's Mac. Record terminal size, event rate, runtime, and machine. This is a target, not a result. Do not attribute model-network latency to the renderer.

### Real integration checks

Use a disposable Git repository with dirty files, separate worktrees, conflicts, and a local bare remote. Verify preservation of unrelated changes and truthful command failures. Do not mutate the user's working repositories or GitHub state for these tests.

A small paid SDK run must verify the actual authentication route, settings, skills, hooks, streamed tool use, a parallel native Workflow, and task interruption. Bound the run's cost explicitly before executing it. Fixture tests cannot establish live integration behavior.

Use the supplied workflow as an acceptance scenario: parallel research, serial Git mutation, independent review, repair, per-commit verification, and CI follow-through. PR and remote CI mutations need a designated repository and explicit user authorization. Until then, report that portion as unverified.

Compare Claude Code and Phi on the same disposable task with matched model, effort, project instructions, tools, and environment. Record outcomes, tool failures, completion time, and usage. Multiple runs are needed before a quality claim. Do not treat identical prompts as proof of identical internal behavior.

Ghostty acceptance must include real keyboard input, long paste, copied output, narrow windows, split panes, suspended work, and long-running tasks. Rex acceptance remains pending until the beta is installed and available. Automated PTY checks do not establish either terminal's manual acceptance.

## Delivery sequence

1. Complete the research and design checks under the user's conditional execution authorization.
2. Complete the implementation plan with concrete files, SDK experiments, acceptance checks, and integration order.
3. Build and test the complete first implementation through that plan. Keep subagents, Workflows, worktrees, and Git behavior in scope throughout.
4. Run the authorized live SDK and Ghostty acceptance checks. Record any unavailable evidence plainly.
5. Refine the interface from use. Add Rex-specific behavior only when it solves an observed need during migration.

## Decisions proposed for review

The user fixed the backend, terminal library, API-credit motivation, advanced workflow scope, and terminal direction. This design proposes main-screen rendering, one active SDK connection, native configuration reuse, and separate task-stop controls.

Detailed workflow inspection uses the pinned SDK's journals for metadata and its public APIs for conversations. The API-key route cannot currently provide the documented agent-team and cloud-peer features. These limits remain visible in the implementation plan.

The design received a direct review against the public SDK declarations and published implementation. Implementation tasks receive separate code and contract reviews.

No installation, live model run, terminal acceptance test, commit, push, or product implementation occurred during this design work.
