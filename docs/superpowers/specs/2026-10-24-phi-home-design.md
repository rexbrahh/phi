# Phi home and authentication

The user requires a Phi-owned home for data, state, and authentication. The default is `~/.phi`. The user also selected an initial copy of existing Claude Code customizations. Existing sessions and Anthropic credentials remain separate.

## Storage contract

| Data | Location |
| --- | --- |
| Saved Phi API key | `<home>/auth.json` |
| Native SDK configuration, history, plugins, and checkpoints | The SDK's supported `CLAUDE_CONFIG_DIR` root at `<home>` |
| Native SDK temporary files | The SDK's supported `CLAUDE_CODE_TMPDIR` root at `<home>/tmp` |
| Explicit-shell output | `<home>/state/<session-id>/shell/` |
| Copied user customizations | Their native settings, skills, agents, commands, hooks, rules, styles, and plugin paths under `<home>` |

`PHI_HOME` can select another absolute path. Resolve it once per process. Project cwd remains independent. Project `CLAUDE.md`, `.claude` settings, and `.mcp.json` remain in the project.

Use the same home for Query options, history workers, pre-query `--continue` lookup, workflow journal validation, shell artifacts, and session replacement. Use `<home>/plugins` as the native plugin parent root. Prepare `<home>/tmp` privately before Query creation. Do not mutate the parent process environment. Preserve Git, SSH, signing, shell, and ordinary tool configuration.

## API key

The home directory uses mode 0700. The saved key uses a private 0600 JSON file and atomic replacement. This file contains plaintext protected by filesystem permissions. Credential reads and errors must not disclose its contents.

Authentication precedence is an explicit `ANTHROPIC_API_KEY` environment value, then the saved Phi key, then a hidden first-run prompt. Do not automatically persist an environment override. Save a prompted key only after explicit submission. Cancel before creating a Query.

Pass the selected key only through the SDK child environment. Do not place it in launch metadata, transcript/history, terminal output, command arguments, or the parent environment. Redact the selected key from app diagnostics. The existing native account-source check remains in place. Saving a key does not prove network authentication or credit eligibility.

`phi auth login` replaces the saved key. `phi auth status` reports its source without revealing it. `phi auth logout` removes only Phi's saved key. An environment override remains effective until the user removes it.

Help, version, auth help, and non-TTY refusal must precede storage creation, migration, prompts, and Query creation.

## Initial customization copy

Read a nonempty inherited `CLAUDE_CONFIG_DIR` as the legacy source. Otherwise use `~/.claude`. Import only the selected customization files and plugin code/cache metadata. Keep executable bits and materialize legitimate skill symlinks as copied content.

Do not copy old transcripts, checkpoints, debug logs, plugin runtime data, or Anthropic credentials. Exclude prior authentication, provider-routing, and storage-root settings. Preserve ordinary hooks and permissions. Keep arbitrary hook commands intact.

When available, copy only global `mcpServers` from the legacy global config. Preserve MCP-specific credentials in private configuration. Do not copy account or trust state. Remap plugin filesystem metadata to copied paths under Phi's home.

Import once. Preserve existing Phi customizations. Record completion only after success and remove only owned staging files on failure. Never execute imported code during copying.

## Evidence and implementation boundaries

Use the pinned SDK and pi-tui. The SDK has no public API-key setter or persistent API-key store. It accepts the key through `Options.env`. Pi-tui's `Input` has no password option, so use its editing logic with a hidden display.

The SDK's public storage-root contract covers native configuration and conversation persistence. Do not invent private checkpoint-directory APIs or promise relocation of arbitrary tool-created project files.

The user controls the home path and its parent. Static symlinks and nonregular credential files are rejected. Concurrent malicious directory replacement by the same account can race path operations. This implementation does not claim protection against that actor.

All tests use disposable homes, synthetic credentials, and fake SDK factories. Native API and human Ghostty acceptance remain distinct gates. The user will supply a real key later.
