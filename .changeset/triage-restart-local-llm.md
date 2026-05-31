---
"helmor": patch
---

Smart triage now restarts the local model if it stopped mid-session, instead of silently producing no tasks until you relaunch the app. Previously, when the bundled local LLM crashed or its health-check gave up, every triage tick failed with "Local LLM is not running" — so freshly-indexed Slack/GitHub/etc. activity never got turned into tasks until the app was restarted.
