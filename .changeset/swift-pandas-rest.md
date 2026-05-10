---
"helmor": patch
---

Improve how thinking blocks are surfaced and rendered:
- Add a Claude Code Thinking Display setting in General (Summarized / Omitted) to control how Claude returns thinking — choosing Omitted speeds up time-to-first-text-token when streaming.
- Stop large reasoning blocks from flickering when they scroll out of view and back, and from stalling workspace switches.
- Keep the conversation's bottom whitespace stable during long streaming replies instead of letting it grow until real content is pushed off-screen.
