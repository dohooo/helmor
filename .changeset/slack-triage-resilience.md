---
"helmor": patch
---

Make Smart triage reliably pick up Slack messages:
- Triage now retries transient Slack failures (DNS, connection, and 5xx errors) instead of dropping the whole fetch, so Slack channel mentions and DMs stop being silently missed.
- The Triage settings panel now flags a Slack source as needing attention (with the failure reason) when its background fetch is failing, instead of always showing it as connected.
