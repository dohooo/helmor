---
"helmor": minor
---

Smart triage now surfaces only items that actually involve you and keeps the proposed-task list clean automatically.

- Triage scans GitHub for items that involve you (assigned / review-requested / @-mentioned / authored) instead of every open issue and PR in your repos, so teammates' routine PRs no longer pile up as tasks. Repos you solely own still surface their open issues so you can triage them.
- The triage judge is now precision-first: it proposes a task only when work is genuinely owed to you and skips by default, rather than proposing whenever it is unsure.
- Proposed-task workspaces whose pull request or issue has since been merged or closed are now archived automatically (and reversibly), so the list no longer fills up with already-finished work.
