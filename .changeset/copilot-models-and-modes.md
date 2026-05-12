---
"helmor": patch
---

Bring GitHub Copilot to feature parity with Codex/Claude in the composer:
- Model picker is now sourced live from Copilot's ACP `SessionModelState` and applied per turn via `unstable_setSessionModel`.
- Plan mode and a Copilot-only Autopilot toggle drive ACP `setSessionMode` (interactive/plan/autopilot).
- Context-window ring + usage status are wired from Copilot's `usage_update` notifications through the same persistence path as Codex.
- Effort levels (low/medium/high/xhigh) are exposed on the static catalog entry.
