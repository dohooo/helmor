---
"helmor": patch
---

Agent questions now stay in the chat as a dedicated Q&A card with your chosen answers highlighted, instead of disappearing after submit (#796).

- Claude AskUserQuestion, Codex requestUserInput and OpenCode questions all render through one unified question UI — Codex questions get the same option-card panel Claude has instead of a generic form.
- Answered, declined and still-open questions are all recorded in the transcript and survive reload.
