# Phi

Phi is a local coding terminal built with the Claude Agent SDK and pi-tui.

Read the [v1 implementation and acceptance report](docs/superpowers/reports/2026-10-24-phi-v1.md) for checked behavior and pending native/terminal acceptance.

## Requirements

- Use Node.js 22.19 or newer.
- Use an interactive terminal for a coding session.
- Phi targets macOS first. Ghostty is the first terminal for manual acceptance. Manual acceptance is not complete.
- Python 3 is needed only for the PTY developer check.

Phi is a normal terminal process. It can also run inside Rex. Phi preserves its inherited environment for tools that use Rex. It does not create or move Rex sessions. Rex-specific behavior is not verified.

## Install and launch from a project directory

Run these commands from the project directory where Phi should work. Replace `/path/to/phi` with the Phi checkout path.

1. Set `PHI_CHECKOUT` to the Phi checkout path.
2. Install the checkout dependencies.
3. Build Phi.
4. Start Phi from the current project directory.

```sh
export PHI_CHECKOUT="/path/to/phi"
npm --prefix "$PHI_CHECKOUT" ci
npm --prefix "$PHI_CHECKOUT" run build
node "$PHI_CHECKOUT/dist/src/cli.js"
```

Phi uses the current directory as its project directory. Pass `--cwd /path/to/project` to select another existing directory. Help and version checks do not need a terminal or API credentials.

```sh
node "$PHI_CHECKOUT/dist/src/cli.js" --help
node "$PHI_CHECKOUT/dist/src/cli.js" --version
```

### Command-line options

| Option | Action |
| --- | --- |
| `--cwd <path>` | Start in an existing directory. |
| `--resume <session-id>` | Resume the session with this UUID. |
| `--continue` | Resume the newest session in the launch directory. |
| `--model <name>` | Select a model for this session. |
| `--effort <level>` | Select `low`, `medium`, `high`, `xhigh`, or `max`. |
| `--permission-mode <mode>` | Select `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, or `auto`. |
| `--plugin-dir <path>` | Load a local plugin directory. Repeat this option to add more directories. |
| `--max-budget-usd <amount>` | Set the SDK model budget for this session. |
| `--dangerously-skip-permissions` | Allow bypass mode. This flag does not select bypass mode by itself. |
| `--help`, `--version` | Show help or the package version. |

`--resume` and `--continue` cannot be used together. Bypass mode requires both `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`.

## Home and authentication

Phi uses `~/.phi` as its home. Set `PHI_HOME` to an absolute, nonempty path to select another home. A relative or empty value is invalid. Phi uses this home as the SDK configuration root and for saved authentication and state. This does not change the project directory. Project `.claude` settings, `.mcp.json`, and `CLAUDE.md` stay in the project.

Phi sets the home directory mode to `0700`. It stores a saved API key as plaintext JSON in `<home>/auth.json` with mode `0600`. These permissions limit access to the file. They do not encrypt the key. Phi passes the selected key through the SDK child environment. It does not put the key in command arguments or application error messages.

Phi selects an API key in this order:

1. A valid inherited `ANTHROPIC_API_KEY`. Phi does not save this override. It takes precedence over a saved key.
2. A saved Phi key in `<home>/auth.json`.
3. A hidden prompt on an interactive coding launch. Phi saves the key after submission. Escape or Ctrl+C cancels the launch before Phi creates a Query.

Use these commands to manage saved authentication:

```sh
phi auth login
phi auth status
phi auth logout
```

From this checkout, run the same commands with `node "$PHI_CHECKOUT/dist/src/cli.js"` in place of `phi`.

`login` requires a terminal and saves or replaces the key. `status` reports the active source and auth path without showing the key. `logout` deletes only the saved Phi key. An inherited `ANTHROPIC_API_KEY` remains active after logout. These commands do not create a Query.

Before Phi accepts a prompt, the SDK must report provider `firstParty` and a supported key source. Supported source values are `ANTHROPIC_API_KEY`, `apiKeyHelper`, and `/login managed key`. This route check does not establish credit eligibility or account balance. Do not place key values in command examples, this repository, or chat. Help and version checks do not initialize the SDK.

## Native configuration

Phi asks the SDK to load the `user`, `project`, and `local` settings. It enables all discovered skills and uses the SDK's native tools and hooks. Phi uses its home as the user configuration root. It keeps project configuration in the project.

On the first interactive coding launch, Phi imports selected Claude Code customizations once. A nonempty `CLAUDE_CONFIG_DIR` selects the import source. If it is unset or empty, Phi uses `~/.claude`. Phi copies `settings.json`, `CLAUDE.md`, skills, agents, commands, hooks, rules, output styles, and selected plugin files and metadata. It copies only global `mcpServers` from `.claude.json`. It preserves existing files in the Phi home.

The import excludes old sessions, transcripts, checkpoints, debug logs, Anthropic credentials, and provider settings. It removes legacy authentication, provider, config-root, and temporary-directory settings from the copied `settings.json`. MCP-specific credentials remain in private copied configuration. Phi does not execute imported code during the copy. Phi copies selected plugin entries under `<home>/plugins/`, including `cache/`, `marketplaces/`, `installed_plugins.json`, and `known_marketplaces.json`. The SDK plugin cache root is `<home>/plugins`. Imported `cache/` files sit inside that root.

Phi routes SDK temporary files to `<home>/tmp` and prepares that directory with private permissions. This overrides an inherited `CLAUDE_CODE_TMPDIR`.

Use repeated `--plugin-dir` options to add local plugins. Use `/phi mcp` to inspect MCP servers or `/phi mcp <server>` to reconnect one. Use `/phi reload` to refresh native plugins, skills, output styles, and commands.

Phi does not provide full Claude Code parity.

Phi reserves `/phi` for local controls. Other SDK slash commands and `@` paths pass through unchanged. Unknown or malformed `/phi` commands stay local and do not become model prompts.

## Local controls

Press Enter to submit a prompt. Use the editor for multiline input, history, paste, and completion.

| Key | Action |
| --- | --- |
| `Ctrl+B` | Ask the SDK to background foreground work. |
| `Escape` | Hide a pending dialog, leave shell mode, close an inspector, or interrupt foreground work, in that order. |
| `Ctrl+C` | Cancel a visible native request, stop a local shell job, interrupt foreground SDK work, or request exit when those are idle. |
| `Ctrl+Z` | Suspend Phi where the terminal supports process suspension. |
| `Ctrl+T`, `Ctrl+R`, `Ctrl+W` | Open task, session-history, or workspace inspectors. |
| `Ctrl+G`, `Ctrl+F`, `Ctrl+Y` | Refresh workspace status, search loaded history, or copy selected output. |
| `Ctrl+V`, `Alt+Backspace` | Attach a clipboard image or remove the most recent attachment. |
| `Ctrl+O` | Open transcript history. |
| `Ctrl+Shift+P` | Open the command palette. |

Permission dialogs accept `1` or `y` to allow once and `d` to deny. They accept `a` to allow the suggested action only when Phi offers that choice. Escape hides a dialog without answering it. Ctrl+C cancels only the visible native request. Phi and its SDK session stay open.

Ctrl+O opens History and hides a visible native request. The request stays pending. Run `/phi questions` to reopen a hidden question or permission. Use `/phi transcript` to open History, `/phi tasks` to open Tasks, and `/phi worktrees` to open Workspace. Run `/phi palette` if the palette key is unavailable.

The command palette lists supported SDK commands and local Phi controls. Select an SDK command to send it through the SDK command path. Select a local control to run its local command. Opening or closing the palette keeps the composer draft.

With a visible native request, Ctrl+C cancels only that request and keeps Phi open. With a running local shell job, it stops the job. With foreground SDK work, it interrupts that work and keeps Phi open. Otherwise, Ctrl+C exits when no draft or background work remains. Phi asks for confirmation before it discards an unsent draft or stops remaining work. Choose “Stop work and exit Phi” to confirm. Choose “Keep Phi open” or press Escape to cancel. `/phi quit` follows the same confirmation rules.

Use `/phi help` to see local commands.

| Group | Commands |
| --- | --- |
| Inspect | `/phi status`, `/phi context`, `/phi model`, `/phi effort`, `/phi permissions`, `/phi tasks`, `/phi workflows`, `/phi transcript`, `/phi copy`, `/phi worktrees` |
| Session | `/phi sessions`, `/phi new`, `/phi resume <id>`, `/phi fork`, `/phi rewind`, `/phi questions`, `/phi quit` |
| Local tools | `/phi shell`, `/phi attach <path>`, `/phi mcp`, `/phi reload`, `/phi palette` |
| Settings | `/phi ultracode`, `/phi workflow-size`, `/phi send <text>` |

In Tasks, press `x` to request a stop for the selected running task. This is separate from foreground interruption. If work is active, repeat the same `/phi new`, `/phi resume <id>`, or `/phi fork` command within 30 seconds to confirm stop-and-switch. Phi opens the target only if stop requests succeed.

Enter shell mode with `/phi shell` or type `!` when the composer is empty. Phi runs each command in the displayed working directory. Escape returns to chat. Ctrl+C stops a running local shell job. Pasted text cannot start shell mode by itself.

Image attachments support PNG, JPEG, GIF, and WebP. One image can be up to 5 MB. Images in one prompt can total up to 20 MB.

## Sessions, process lifetime, and rewind

`--resume <session-id>` and `--continue` reopen conversation history in a new Phi process. `--continue` selects the newest session in the launch directory. They do not restore local child processes or guarantee that an earlier workflow continues.

Use `/phi sessions` to list sessions. Use `/phi new`, `/phi resume <id>`, or `/phi fork` to switch inside Phi. If you exit while background work remains, Phi closes its SDK query and local shell. A later resume restores conversation history, not those running processes.

Use `/phi rewind` only when the session is idle and Phi has an SDK checkpoint. Phi shows a fresh preview first. Run the command again to apply the preview. Rewind applies SDK file checkpoints. It does not undo Git or shell effects, and it is not a full task rollback.

Local shell output appears in the transcript as a bounded preview. Phi stores full stdout and stderr files under `<home>/state/<session-id>/shell/`. The session record contains their paths. Phi keeps these files after exit until you remove them.

## Developer checks

Run `npm run build`, `npm run typecheck`, or `npm test` from the checkout. The PTY, load, and live test harnesses are included in this checkout. Manual acceptance is not complete.

```sh
npm run test:pty
npm run test:load
```

Run a live check only with separate approval and an inherited `ANTHROPIC_API_KEY`. The fixture pins the main session, resumed session, and both native Workflow agents to `claude-haiku-5-5`, uses low effort and a 1024-token output cap, and rejects budgets above 0.10 USD total. Its command does not accept a key argument:

```sh
PHI_LIVE_TEST=1 npm run test:live -- --max-budget-usd 0.10
```

The runner divides the configured total between the initial query and resume, and checks cumulative SDK model usage and reported cost. SDK estimates and calls already in flight can still exceed the requested budget.
