---
"helmor": patch
---

Add a backend `load_dashboard_snapshot` command that groups workspaces into kanban lanes (in-progress / review / done / backlog / canceled / archived) with a live `isStreaming` overlay, so the upcoming dashboard view (#482) can render cards without rewriting the sidebar's aggregate queries.
