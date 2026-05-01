---
"helmor": patch
---

Pull now mechanically stashes uncommitted work, fast-forwards from the target branch, and re-applies the stash — instead of asking the agent to commit and push for you. Only an actual merge conflict (or a stash-pop conflict) hands off to the agent, with a narrower prompt that no longer prescribes commit/push.
