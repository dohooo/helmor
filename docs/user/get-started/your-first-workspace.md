# Your first workspace

This walkthrough takes you from an empty sidebar to a merged pull request.

## 1. Add a repository

Click **Add Repository** in the sidebar (or right-click → *Add repository*).
You can either:

- **Link a local clone** — pick any folder that is already a git repository.
- **Clone from URL** — paste a git URL and choose where to clone it.

Helmor detects the default branch and remotes, and binds the repository to the
GitHub/GitLab account that has access to it. Requirements: the repository must
have at least one remote (usually `origin`).

## 2. Create a workspace

Press **⌘N** (or click **New Workspace**). Pick the repository, give the task
a name, and go.

Behind the scenes, Helmor:

1. creates a **git worktree** under `~/helmor/workspaces/<repo>/<name>/` —
   a full working copy on its own branch, isolated from your clone;
2. names the branch from your repo's branch prefix (configurable per repo);
3. runs your project's **setup script** if one is configured — installing
   dependencies, copying `.env` files, whatever the project needs
   (see [Configure your project](configure-your-project.md)).

Prefer a chat without any repository? **⌘⇧N** creates a *Just chat* workspace
in a scratch directory.

## 3. Prompt an agent

Type what you want in the composer at the bottom:

- Mention files with `@` — type `@` and fuzzy-search the workspace.
- Paste screenshots or drag files straight into the input.
- Pick the **model** (⌥P) and an **effort level** from the toolbar.
- Not sure about the approach? Toggle **Plan mode** (⇧Tab) and the agent will
  propose a plan before touching any files.

Press **Enter**. The agent's work streams in live — messages, tool calls, file
edits, reasoning. You don't have to watch: switch to another workspace and the
sidebar will show a dot when this one needs you.

Want to redirect a running agent? Just type again — the button becomes
**Steer** and your message is injected mid-turn. **⌘Enter** queues the message
for after the current turn instead.

## 4. Review the changes

Open the inspector (**⌘⌥B**). The **Changes** section lists every modified
file with insertions/deletions; click one to read a side-by-side diff. Need to
tweak something by hand? Switch the diff to edit mode (**⌘E**) — it's a full
Monaco editor.

Run your project's dev server or tests from the **run scripts** panel (**⌘J**,
then **⌘R** to run), or open a built-in **terminal** in the workspace
directory.

## 5. Ship it

The inspector's action button adapts to the workspace state:

- **Commit & Push** (⌘⇧Y) — commit everything and push the branch.
- **Create PR** (⌘⇧P) — open a pull request against the target branch.
- **Pull Latest** (⌘⇧L) — merge the target branch in if you've fallen behind.
- **Fix CI** / **Resolve Conflicts** — dispatch an agent at the problem.
- **Merge** (⌘⇧M) — merge the PR when checks are green.

When the PR merges, archive the workspace (right-click → *Archive*, or enable
*archive on merge* per repository). The worktree is removed, the branch is
cleaned up if Helmor created it, and the conversation stays in your history —
restorable any time.

## Next

- Run several of these at once: [Parallel agents](../concepts/parallel-agents.md)
- Make new workspaces instantly productive: [Configure your project](configure-your-project.md)
- Build dependent changes: [Stacked PRs](../concepts/stacked-prs.md)
