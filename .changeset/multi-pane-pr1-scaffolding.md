---
"helmor": patch
---

Add the multi-pane shell scaffolding (PanesProvider, PanesGrid, PaneShell, PaneIdentityContext, PaneErrorBoundary). No user-visible change yet; PanelContainer still reads its workspace/session from the existing app-shell state. This is the foundation for surfacing multiple chat sessions in parallel.
