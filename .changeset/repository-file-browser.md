---
"helmor": minor
---

Add repository file browser to Git panel with tab-based navigation. Users can now browse the full workspace file tree alongside Git changes, reducing context switching during development.

- Tab-based UI with "Changes" and "Files" tabs in Git panel header
- Files tab displays complete repository tree (respects .gitignore)
- Shared tree/list view toggle between both tabs
- Tab preference persisted to localStorage
- Files open in read-only mode for clean browsing experience
