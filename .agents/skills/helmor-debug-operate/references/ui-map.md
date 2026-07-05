# Helmor UI Map For Tauri MCP

Use this map to decide which recipe or selector to use. It is not a substitute for live verification; always re-snapshot or inspect DOM state after each action.

## Shell

- Application shell: `[aria-label="Application shell"]`
- Workspace sidebar: `[aria-label="Workspace sidebar"]`, `[data-helmor-sidebar-root]`, `[data-shell-pane="sidebar"]`
- Workspace panel: `[aria-label="Workspace panel"]`
- Workspace viewport: `[aria-label="Workspace viewport"]`
- Workspace header: `[aria-label="Workspace header"]`
- Left resize handle: `[aria-label="Resize sidebar"]`, `role="separator"`
- Right inspector sidebar: `[aria-label="Inspector sidebar"]`, `[data-shell-pane="inspector"]`
- Right resize handle: `[aria-label="Resize inspector sidebar"]`

## Sidebar And Workspaces

- Top buttons:
  - `Workspace location`
  - `Filter and sort sidebar`
  - `Add repository`
  - `New workspace`
  - `Collapse left sidebar`
- Workspace rows:
  - Prefer `[data-workspace-row-id]` when available.
  - Fallback: row `role="button"` with `workspace-row` classes and matching text/aria-label.
  - Selected row class: `.workspace-row-selected`
- Row actions:
  - `Archive workspace`
  - `Restore workspace`
  - `Delete permanently`
  - Context-menu actions in code include `Pin/Unpin`, `Set status`, `Mark as unread`, `Open in Finder`, and `Move into a new worktree`.
- Group headings observed:
  - `Chats`
  - `Done`
  - `In review`
  - `In progress`
  - `Backlog`
  - `Canceled`
  - `Archived`
  - Group headers are safe to collapse/expand; click the header rect, then verify child row visibility.

## Header And Sessions

- Session tabs: `[role="tablist"][aria-label="Sessions"]`, `[role="tab"]`
- Session tab actions:
  - `Rename session`
  - `Close session`
- Header buttons:
  - `New session`
  - `Session history`
- Hidden session history can show:
  - `No hidden sessions`
  - `Restore session`
  - `Delete session permanently`
- Non-chat workspaces may show workspace header actions:
  - `Open in <editor>`
  - Open-in dropdown trigger near `Open in Warp` (`button[data-slot="dropdown-menu-trigger"][data-size="xs"]`) with `Finder`, `Cursor`, `VS Code`, `Xcode`, `Terminal`, `Warp`
  - `More workspace actions`
  - `Expand right sidebar` / `Collapse right sidebar`
  - Right sidebar state is best verified by the button label plus `[aria-label="Inspector sidebar"]` `aria-hidden`, not only by raw DOM width.
  - `Create PR options` opens `Create draft PR` / `Create PR manually`; opening is safe, selecting is a real PR action.

## Composer

- Composer: `[aria-label="Workspace composer"]`
- Input: `#workspace-input`, `[aria-label="Workspace input"]`, `role="textbox"`
- Model menu: Radix dropdown trigger whose text includes the current model, for example `ClaudeOpus 4.8 1M`
- Controls:
  - `Fast mode`
  - `Carry room context`
  - Effort menu text such as `high`
  - `Plan mode`
  - `Terminal mode` when enabled
  - `Add context`
  - `Context usage`
  - `Usage Stats` when enabled
  - Terminal mode enabled class includes `text-emerald-500`; disabled class includes `text-muted-foreground/70`.
  - `Add context` toggles the right inspector between normal Git and `Contexts` mode in repo-backed workspaces.
  - `Context usage` and `Usage Stats` may require hover or another precondition; click/long-press did not open stable pickers in observed states.
- Submit states:
  - `Send`
  - `Stop`
  - `Steer`
  - `Request Changes`
  - `Implement`
- Start surface can show:
  - `What should we work on?`
  - `New Workspace`
  - `Start options`
  - `Just chat`
  - `Save for later`
  - `Start now`

## Settings

Open from the first bottom-left sidebar icon or `Cmd+,`.

Sections observed:

- General:
  - `Desktop Notifications`
  - `Notification sound`
  - `Expand terminals on hover`
  - `Terminal Mode`
  - `Always show context usage`
  - `Usage Stats`
  - `Auto-archive on merge`
  - `Follow-up behavior`
  - `Queue`
  - `Steer`
  - `Claude Code Thinking Display`
  - `Clean up archived workspaces`
  - `App Updates`
  - `Helmor Components`
- Appearance:
  - `Theme`
  - `Color Theme`
  - `Chat font size`
  - `UI font`
  - `Code font`
  - `Terminal font`
  - `Use pointer cursors`
- Models:
  - `Default model`
  - `Review model`
  - `Action model`
- Providers:
  - `OpenCode`
  - `MiMo Code`
  - `Claude Code`
  - `Codex`
  - `Kimi`
  - `Cursor`
  - `Proxy`
  - Provider actions include `Log in`, `Sync models`, `Fetch models`, `Add provider`, `Get your API key`
- Shortcuts:
  - Full shortcut table including navigation, session, workspace, actions, system, composer, start surface, editor, and terminal.
  - Shortcut buttons begin keybinding edit flow. Do not click them unless the user wants to edit keybindings.
- Accounts:
  - Connected forge accounts synced from local `gh` / `glab`.
  - Do not copy account names or emails into skill output.
- Team:
  - `Join with invite link`
  - `Team mode`
  - `Worker URL`
  - `Access token`
  - `Test connection`
  - `Create team`
  - `Mint invite`
  - Cloud identity authorization for Codex and Claude.
  - Do not copy token values into skill output.
- Contexts:
  - Provider tabs `GitHub`, `GitLab`, `Slack`, `Linear`, `Mobile`
  - Repository selector
  - Issue/PR feed switches, sort dropdowns, selected labels, and `Remove All`
  - Treat switches and remove actions as configuration mutations.
- Experimental:
  - `Local LLM`
  - `Mobile companion`
  - `Smart triage`
  - Triage source connections, model add/delete/apply controls, mobile pair/revoke controls
  - Treat connect, delete, run, pair, revoke, and apply actions as high-impact.
- Developer:
  - `Show Onboarding Again`
  - `Reset Onboarding`
  - `Reset All Dev Data`
  - Treat reset actions as destructive. Do not execute during ordinary verification.
- Repository-specific settings:
  - Left-nav repo entries appear below `Repositories`.
  - Use button rects instead of text selectors; repo names also appear in the body.
  - Sections include Remote origin, base branch, branch prefix, setup/run/archive scripts, built-in prompt preferences, and Delete Repository.
  - Do not record script contents, edit textareas, add scripts, change remotes/branches, or delete repositories without explicit user intent.

## Feedback

- Button selector: `button:has(svg.lucide-message-square-warning)`
- Dialog:
  - Title/text `Send feedback`
  - Input `#feedback-input`, aria-label `Feedback`
  - Actions: `Create issue`, `Quick fix`, `Close`
  - Follow-up flow may include `Confirm send` and `Send to agent`

## Inspector And Editor

These require a repository-backed, non-chat workspace.

- Chat-mode workspaces hide the inspector toggle and the inspector pane.
- Inspector pane selectors:
  - `[aria-label="Inspector sidebar"]`
  - `[data-shell-pane="inspector"]`
- Inspector sections from code:
  - `[aria-label="Inspector section Git"]`
  - `[aria-label="Changes panel body"]`
  - `[data-change-path]`
  - `[aria-label="Inspector section Actions"]`
  - `[aria-label="Inspector section Tabs"]`
- Inspector actions from code:
  - `Stage all changes`
  - `Unstage all changes`
  - `Stage file`
  - `Unstage file`
  - `Discard file changes`
  - `Review changes`
  - `Commit and push`
  - `Push`
  - `Resolve`
  - `Pull`
  - `Run setup`
  - `Add run script`
  - `Run`
  - `Stop`
  - `Force Stop`
  - `Open dev server`
  - `Switch to list view`
  - `Switch to tree view`
- Inspector tabs from code:
  - `#inspector-tab-setup`
  - `#inspector-panel-setup`
  - `#inspector-tab-run`
  - `#inspector-panel-run`
  - `button[aria-label="Switch run action"]`
  - `#inspector-tab-terminal-*`
  - `#inspector-panel-terminal-*`
  - `#inspector-tab-terminal-placeholder`
  - `button[aria-label="Close Terminal"]`
  - `button[aria-label="New terminal"]`
  - `button[aria-label="Toggle inspector actions section"]`
  - `button[aria-label="Toggle inspector tabs section"]`
- Editor selectors from code:
  - `[aria-label="Workspace editor surface"]`
  - `[data-focus-scope="editor"]`
  - `[aria-label="Editor canvas"]`
  - `[data-change-path="<relative/path>"]` opens a Git change in the editor/diff surface.
  - `button[aria-label="Close diff view"]`
  - `button[aria-label="Close editor view"]`
  - `button[aria-label="Copy absolute path"]`
  - `button[aria-label="Open file"]`
- Editor operations from code:
  - `Open file`
  - `Search files`
  - `Source`
  - `Preview`
  - `Edit`
  - `Diff`
  - `Close diff view`
  - `Close editor view`
  - `Copy absolute path`
  - Diff mode shows top button text `Edit⌘E`.
  - Edit mode shows top button text `Diff⌘E` and `.monaco-editor`.

## Destructive Or High-Impact Operations

Do not execute these unless explicitly requested or operating on a disposable test workspace:

- `Archive workspace`
- `Delete permanently`
- `Reset All Dev Data`
- `Discard file changes`
- `Delete session permanently`
- Git remote operations: push, merge, close PR/MR
- Running arbitrary scripts or terminal commands
- Cloning or adding repositories into persistent app data
