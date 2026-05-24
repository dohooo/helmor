---
"helmor": minor
---

Add Smart Triage, a new section under Experimental → Local LLM that periodically scans your inbox sources and creates AI-prepared workspaces for actionable items:
- Sources: Slack, Lark, GitLab, GitHub — each toggled independently and routed through Helmor's existing forge / chat integrations.
- Per-forge scan modes: your inbox (assigned / mentioned) and a whole repo's open issues / PRs, so the agent can also pick up things filed by other people.
- Captures images and screenshots referenced in a message and hands them to the new workspace so the downstream agent can read them.
- Auto-run can be paused for manual-only operation; Run now always works.
