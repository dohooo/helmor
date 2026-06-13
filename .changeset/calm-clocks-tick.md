---
"helmor": minor
---

Add Automations — scheduled prompts that run on an interval, like Codex's:
- New Automations page (clock icon at the bottom of the sidebar): create automations manually or via chat, pause/resume, edit the interval, or run one immediately.
- Each run sends the saved prompt into its chat as a normal agent turn, labeled "Sent via automation" — the chat itself is the run history. Runs can target an existing chat or create a fresh session per run in a workspace.
- Intervals: hourly, daily, weekly, or every N minutes/hours. Schedules survive restarts and sleep — a slot missed while Helmor was closed catches up exactly once on next launch, and never double-fires.
- New `helmor automation` CLI (list/create/show/pause/resume/run/delete), so agents can set up automations for you straight from a conversation.
