# Inbox Source Drag Into Kanban Research Plan

## Main Question

Why does dragging an inbox source card into a kanban column fail to show the same drop target highlight and shadow placeholder as dragging a workspace card between kanban columns?

## Subtopics

1. dnd-kit event model and supported drag sources
   - Confirm whether dnd-kit droppables react to native HTML drag events.
   - Identify the intended pattern for cross-container custom drag sources.

2. Native HTML drag-and-drop constraints
   - Confirm browser/WebView requirements for dragenter/dragover/drop.
   - Identify common reasons custom MIME payload detection fails.

3. Local DOM/event structure
   - Inspect where kanban droppable refs are attached.
   - Inspect whether a child element overlays or owns the actual visible drop area.
   - Inspect whether the native event handlers are attached to the element that actually receives drag events.

4. Implementation options
   - Compare fixing the native bridge versus moving inbox source drag into dnd-kit.
   - Recommend the smallest robust implementation for the current UI.

## Synthesis

Combine official documentation with local source inspection. The final answer should distinguish confirmed facts from inferences and propose a concrete implementation path.
