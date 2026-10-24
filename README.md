# Phi

Phi is a local coding terminal that uses the Claude Agent SDK and pi-tui.

## Run

Use Node.js 22.19 or newer.

```sh
npm install
npm run build
npm start -- --help
npm start
```

Phi needs an interactive terminal for a session. It uses the current directory by default. Pass `--cwd <path>` to choose another directory, `--resume <session-id>` to resume a session, or `--continue` to resume the newest session in the launch directory. `--help` and `--version` work without a terminal or API credentials.

## Keyboard

- Enter sends a prompt. Use pi-tui's editor keys for multiline input, history, paste, and completion.
- Native SDK slash commands and `@` mentions pass through unchanged.
- `/phi help` shows local commands. `/phi shell` enters explicit shell mode; `/phi attach <image path>` attaches an image.
- Ctrl+V reads an image from the clipboard. Alt+Backspace removes the last attached image.
- Ctrl+T opens SDK task and child transcript inspection. Ctrl+R opens session history. Ctrl+W opens Git/worktree status. Ctrl+G refreshes Git status.
- Ctrl+F filters the loaded history page with the current composer text. Ctrl+Y copies the selected output.
- In shell mode, Enter runs the command in the displayed cwd snapshot. Ctrl+C stops a running local shell job. Escape returns to chat.
- Permission and question dialogs are separate from the composer. Escape hides a dialog without answering it. Ctrl+O reopens a hidden pending dialog.

Local shell commands write bounded previews and full output files under `${XDG_STATE_HOME:-~/.local/state}/phi/<session-id>/shell/`. Phi records the output paths in the session and keeps these files until the user removes them.

Image submissions support PNG, JPEG, GIF, and WebP. A single image can be up to 5 MB; images in one prompt can total up to 20 MB.
