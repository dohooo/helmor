---
"helmor": patch
---

Make Smart triage reliably pick up Slack channel @-mentions, and stop background fetching entirely for users who haven't enabled it:
- Triage now indexes the channels you were @-mentioned in — including mentions inside threads (the full thread is pulled in for context) and channels you aren't a member of. Previously thread mentions were silently dropped and channels were crowded out by your DMs, so those tasks never surfaced.
- When Smart triage is turned off, Helmor no longer runs any background Slack/GitHub/GitLab/Lark fetches, so people who don't use the feature incur zero background activity.
