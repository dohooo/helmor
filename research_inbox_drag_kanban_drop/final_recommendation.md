# Final Recommendation

## Best Solution

Use one shared dnd-kit `DndContext` for both the left inbox source cards and the right kanban columns.

The failed implementation mixed two drag systems:

- inbox cards used native HTML drag and drop;
- kanban workspace cards and columns used dnd-kit.

This caused the left source card to start dragging successfully, but the right kanban column never received native `dragenter` / `dragover` events in our current Tauri/WebView layout. The source payload reached React state, but the column-level native handlers never ran.

## Why This Is Correct

- dnd-kit is intentionally not built on the HTML5 Drag and Drop API. Its droppable detection works through registered draggables, droppables, sensors, and collision detection inside the same `DndContext`.
- MDN documents native drag/drop as event-target based and requiring `dragover.preventDefault()` for valid drops. That is fragile when the event never reaches the intended target.
- Our desired UX is exactly dnd-kit behavior: pointer-based collision, shared drop target state, drag overlay/transform, and consistent placeholder rendering.

## Implementation Shape

- Move `DndContext` to the shared App area that wraps both `InboxSidebar` and `KanbanPage`.
- Convert `SourceCard` from native `draggable` to dnd-kit `useDraggable`.
- Register inbox drag data with `active.data.current`.
- Let `KanbanPage` handle both workspace-card drags and inbox-source drags in the same dnd-kit event handlers.
- Keep kanban columns as existing `useDroppable` targets.
- Reuse the existing column `isDropTarget` and `KanbanDropPlaceholder` rendering path.

## Sources

- dnd-kit documentation: https://dndkit.com/react/quickstart
- dnd-kit docs repository: https://github.com/dnd-kit/docs
- MDN drag operations: https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Drag_operations
- MDN drop event: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/drop_event
