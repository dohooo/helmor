# Kanban Card Drag Research Plan

Main question: how should Helmor implement card drag-and-drop across columns and within a column using the already installed stack?

Subtopics:
- Current local implementation: identify existing data shape, component boundaries, and installed drag dependencies.
- dnd-kit best practices: confirm recommended primitives for sortable lists, multiple containers, collision detection, sensors, and overlays.
- Helmor integration plan: map the best-practice approach onto the smallest code changes in `src/features/kanban/`.

Synthesis:
- Produce a concise Chinese summary with the recommended implementation path, caveats, and source URLs.
