# Claude Command Center

One VS Code window, many **native** Claude Code sessions. Each session runs in its own project folder
(projects are never merged). All of them sit side by side in a grid of panes that you can resize and rearrange.
Your **existing** conversations resume with their full history.

This extension never draws Claude's interface itself. Every pane is Anthropic's own Claude Code:

- **Official Claude Code chat panel** for chats of the window's first folder.
- **Claude Code CLI** (in a terminal pane) for every other project.

The extension only finds your conversations, places them in panes, and launches them with their history. When
Claude Code or its VS Code extension updates, the panes pick up the update automatically, with nothing to change here.

## Why two kinds of pane

VS Code's official Claude Code chat panel always runs in the window's **first folder**, and only finds chat
history for that folder. It cannot be pointed at another project. So:

| Project | Pane | History |
|---|---|---|
| The window's first folder | Official chat panel (bubbles, model picker, `/` menu, Remote Control...) | Loaded by the official extension |
| Any other project | Claude Code CLI, started in that project's folder | `claude --resume <id>`: Claude gets the whole conversation back as context, and the CLI reprints it |

Both are the same Claude Code agent with your subscription, settings, CLAUDE.md, MCP servers and hooks. Any chat
can also be opened in the CLI (right-click a chat, then **Open in Claude Code CLI**).

## How it works

| Need | How |
|---|---|
| Keep projects separate | Each CLI pane starts `claude` with its working folder set to that project. No multi-root merge is needed. |
| Keep chat history | Claude Code (CLI **and** the official chat panel) saves every conversation in `~/.claude/projects/<folder>/<session-id>.jsonl`. The sidebar reads those files (read only) and lists every conversation by project. |
| See everything at once | Panes are editor groups laid out as a grid (2 side by side, 2x2 quadrants, 3x2, 3x3...). Drag the borders between panes to resize them and drag tabs to rearrange. `Ctrl+Alt+M` maximizes a pane; press it again to go back. |
| Know who needs you | CLI panes show working / waiting / ready in the Board view and status bar. A notification appears when a background session finishes or seems to wait for approval. (Official panels have their own indicators.) |
| Survive restarts | The board's CLI panes are saved per workspace and reopened with `--resume`. Official chat tabs are restored by the official extension. |

## Using it

1. Click the **Claude Command Center** icon in the activity bar.
2. **Projects & Sessions** lists every folder that has Claude conversations. Pin the ones you use (pin icon) or add folders (folder+ icon).
3. Click a conversation to open it on the board. It goes into the next empty pane, and the grid grows when every pane is full. You can also:
   - `+` on a project: start a new chat in that folder
   - `▷` on a project: resume its most recent chat
   - Right-click a chat: open it in the CLI, open it as a tab in the current pane, fork it, preview the transcript, or copy its resume command
4. **Open Sessions as Grid...** (layout icon): pick several chats or new sessions at once, one pane each.
5. **Board** view: change the layout, **Tidy** (one tab per pane), **Send prompt to several CLI sessions**, restore the last board, close all.

Shortcuts: `Ctrl+Alt+K` jump to a session, `Ctrl+Alt+M` maximize or restore the current pane, `Ctrl+Alt+B` send a prompt to several sessions.

Tip: open the project you work in most as the window's first folder; its chats then get the official chat panel.
To also see the other projects' files in the Explorer, right-click a project, choose **Add Folder to Workspace**, and save the
workspace (File > Save Workspace As). Folders in a multi-root workspace stay separate.

**Do not keep the same conversation open in two places at once** (for example in a CLI pane and in the official
panel). Two programs writing to one conversation can split its history into two branches.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeCC.preferOfficialPanel` | `true` | Open the first folder's chats in the official chat panel (otherwise in the CLI) |
| `claudeCC.claudeCommand` | `claude` | Path to the CLI if it is not on PATH |
| `claudeCC.extraArgs` | | Extra CLI arguments, e.g. `--model opus` |
| `claudeCC.claudeDataDir` | `~/.claude` | Override where conversations are read from |
| `claudeCC.restoreOnStartup` | `true` | Reopen the board when VS Code starts |
| `claudeCC.notifyWhenDone` | `true` | Notifications for finished or waiting CLI sessions |
| `claudeCC.showDiscoveredProjects` | `true` | List unpinned folders found in your history |
| `claudeCC.sessionsPerProject` | `15` | Chats shown per project before "show older" |
| `claudeCC.colorTerminals` | `true` | Each project gets its own tab color |

## Install

```
code --install-extension claude-command-center-0.4.0.vsix
```
Or in VS Code: Extensions view > `...` > **Install from VSIX...**

Requirements: VS Code 1.90 or later and the Claude Code CLI, installed and logged in (`claude` works in a terminal).
The official Claude Code extension is optional; it is needed only for the official chat panel.

## Development

No build step and no runtime dependencies: plain JavaScript.

```
npm run package     # builds the .vsix
xvfb-run -a node test/run.js <dir with @vscode/test-electron> [shot.png] <VS Code binary>
```
`test/run.js` starts a real VS Code with a fake `claude`. It checks:
- discovery of conversations and projects
- resuming each conversation in its own folder
- growing the grid, tidy, persistence and restore
- status detection
- routing: chats of the first folder go to the official panel's own command, with the session id and target pane;
  other projects go to the CLI; "Open in Claude Code CLI" bypasses the official panel
