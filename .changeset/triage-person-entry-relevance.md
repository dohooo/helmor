---
"helmor": minor
---

Smart triage now keys off whether something actually involves you, across every source:
- Slack/IM triage surfaces only direct messages to you and threads that @-mention you — group chats you're merely a member of, and channels where you only posted, no longer become tasks.
- Each proposed task records why it reached you (assigned, review-requested, @-mentioned, your own work, or a repo you solely own) and restates that reason in its plan.
- Auto-cleanup now also retires proposed tasks that no longer involve you — a teammate's open PR you were never asked about, or a Slack thread that no longer @-mentions you — on top of ones whose PR/issue has merged or closed. Archiving stays reversible.
