# Composer

The composer is the prompt input at the bottom of every session. It looks like
a text box; it does considerably more.

## Writing the prompt

| Feature | How |
| --- | --- |
| **File mentions** | Type `@` and fuzzy-search files in the workspace; the agent receives the path |
| **Slash commands & skills** | Type `/` to browse the agent's commands and installed skills |
| **Images** | Paste a screenshot, or drag image files onto the input — they attach as chips |
| **Large pastes** | Big blocks of pasted text collapse into a badge (hover to preview) instead of flooding the input |
| **Linked directories** | `/add-dir` links another directory into the session's context; linked dirs show as chips above the input |
| **Prompt history** | **↑** at the start of the input recalls previous prompts, shell-style; **↓** walks back to your draft |

## The toolbar

| Control | What it does |
| --- | --- |
| **Model picker** (⌥P) | Choose provider and model for this session ([Agents & models](../concepts/agents-and-models.md)) |
| **Effort** | Reasoning depth: `low` → `max`, model-dependent |
| **Plan mode** (⇧Tab) | Agent proposes a plan instead of editing files; approve to implement |
| **Fast mode** | Faster, lighter turns on supported models |
| **Terminal mode** (⌘⇧T) | Send the prompt to the agent's own TUI in a built-in terminal |
| **Context panel** (⌘⌥C) | Browse issues, PRs, and notifications from connected sources and drop them into the prompt |
| **Context usage ring** | How full the model's context window is; hover for details |

## Sending

- **Enter** — send. During a running turn the button becomes **Steer**, and
  your message is injected into the turn in progress.
- **⌘Enter** — the opposite of whatever the button currently does: queue the
  message for after the turn instead of steering (or vice versa).
- **Queued prompts** are listed above the composer — edit, remove, or promote
  any of them to steer immediately.

## When the agent asks back

Permission requests, plan approvals, and clarifying questions render as
interactive panels in place of the composer — answer them inline and the agent
continues. A free-text "Other" answer is always available on multiple-choice
questions.

## Focus

**⌘L** focuses the composer from anywhere in the app.
