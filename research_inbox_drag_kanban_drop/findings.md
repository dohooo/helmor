# Findings: Inbox Source Drag Into Kanban

## External Sources

- dnd-kit official docs state that dnd-kit is intentionally not built on the HTML5 Drag and Drop API. Its `useDraggable` / `useDroppable` interaction model is driven by dnd-kit sensors and registered draggables, not arbitrary native `draggable` elements. Source: https://github.com/dnd-kit/docs
- Context7 dnd-kit documentation shows the expected model: draggable elements are registered via `useDraggable`, droppable elements via `useDroppable`, and drag lifecycle events are emitted by `DndContext` / `DragDropProvider` for those registered entities. Source: https://dndkit.com/react/quickstart and Context7 result for `/websites/dndkit`
- MDN documents that native HTML drop targets need `preventDefault()` during `dragover` for `drop` to fire reliably. Source: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/drop_event
- MDN also describes `DataTransfer` as the native drag data store. It is browser-managed during drag operations, which makes it a less reliable source of app-internal UI state than React state when both source and target live in the same app. Source: https://developer.mozilla.org/docs/Web/API/HTML_Drag_and_Drop_API/Recommended_drag_types

## Local Findings

- Our kanban workspace-card drag uses dnd-kit end to end: `KanbanCard` is registered with `useDraggable`; `KanbanColumn` is registered with `useDroppable`; `KanbanPage` owns `activeRow`, `overColumnId`, and placeholder state.
- The inbox source cards were implemented as native HTML `draggable` elements outside the `DndContext`.
- The previous bridge tried to infer "this native drag is an inbox source" from `event.dataTransfer.types` inside the kanban column's native `dragenter` / `dragover`.
- That made the UI signal dependent on browser/WebView drag data exposure. If the custom MIME type is not visible during protected drag phases, the branch returns before calling `preventDefault()` and before setting the target column state. Result: no column highlight and no placeholder.
- This is not mainly a visual layering issue. The kanban columns are visible and can receive pointer interaction. The weak point is mixing dnd-kit stateful droppable UI with a native drag source but not maintaining app-level drag state.

## Recommendation

For same-window drag from inbox to kanban, the robust fix is to keep the active inbox source in React state at `dragstart`, pass it into `KanbanPage`, and let `KanbanColumn` use that state to:

- accept native `dragenter` / `dragover`;
- call `preventDefault()`;
- set the target column;
- render the same placeholder/highlight path as workspace-card drags.

`DataTransfer` should remain only as a fallback payload transport for `drop`, not as the source of truth for hover-state detection.
