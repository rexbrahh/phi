# Coding-harness usability review

Checked 2026-10-26 against Phi 1.0.3 (`08a9a87`). The changes use Claude Agent SDK for model execution and the installed pi-tui components for the interface.

| Observed Phi gap | Reference behavior | Implemented behavior |
| --- | --- | --- |
| App shortcuts consume normal editor keys | [Pi editor shortcuts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md) | Ctrl+W and Alt+Backspace delete a word. Ctrl+F moves forward. Ctrl+Y restores deleted text. Inspector shortcuts use Ctrl+Shift. |
| Local controls are absent from slash completion | [Pi autocomplete](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md) | `/phi` subcommands use the same completion provider as SDK commands and file paths. |
| Sessions are a 20-row text dump of IDs | [OpenCode session selection](https://opencode.ai/docs/tui/#sessions) | Search project sessions by title, branch, or ID, then press Enter. All SDK pages are loaded. Closing the picker revokes its pending confirmation. |
| Tool input objects dominate narrow screens | [OpenCode details toggle](https://opencode.ai/docs/tui/#details), [Gemini compact output](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md) | One row combines the tool name, state, and description. Output uses one preview row, or three for failures. `/phi details` expands the retained input and output. |
| Copy requires opening an inspector | [Pi copy command](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md) | `/phi copy` and Ctrl+Shift+Y copy the latest completed main assistant message. Inspectors retain their selected-output behavior. |
| Long drafts cannot use an external editor | [Pi external editor](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md), [OpenCode editor](https://opencode.ai/docs/tui/#editor) | Ctrl+G or `/phi editor` opens VISUAL, EDITOR, or vi. Saving returns the draft without submitting it. |

These changes reproduce interaction patterns. They do not replace the agent harness or add dependencies.

User screenshots on 2026-10-26 showed more transcript clutter. The renderer now uses inline prompt and reply markers instead of separate role headings. It formats complete native command envelopes without changing stored messages. Routine and unknown SDK events remain available through `/phi diagnostics`. Actionable warnings use short rows. Known thinking signatures no longer produce warnings. Idle and waiting states exclude stale request phases.

## Verification scope

Deterministic tests cover completion, more than one page of sessions, cancellation during metadata lookup, active-work confirmation, terminal-text sanitization, resize, copying, and tool-detail bounds. External-editor checks use a private temporary prompt and fake SDK. They cover multiline text, file permissions, Git environment isolation, failure recovery, terminal ownership, and shutdown.

The isolated Ghostty attempt stopped at the lock screen before visual interaction. The fixture restored terminal settings and preserved the existing windows. That attempt is not a visual pass.

Research also identified editable follow-up queues, configurable app hotkeys, a live context display, elapsed time, and search across all history pages. They are outside this patch. Queue controls need a separate design against the SDK's asynchronous input behavior. Context values must come from the SDK.

The Workflow-child stop limitation remains unchanged. This review does not establish Claude Code feature parity.
