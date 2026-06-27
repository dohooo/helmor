---
"helmor": patch
---

Wire Claude `/context` and `/compact` slash commands through to the Agent SDK — the wrapped prompt previously hid them from the SDK's root-command detection — and surface the compact lifecycle as system notices with a spinner while compacting and a check when done.
