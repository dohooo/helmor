# Kanban Drag Findings

Local implementation:
- `src/features/kanban/index.tsx` renders columns from `workspaceGroupsQueryOptions()`.
- `projectGroupsToKanbanColumns()` de-duplicates workspace rows and buckets them by normalized `status`.
- `KanbanColumn` and `KanbanCard` are currently presentational; no local board state or drag hooks.
- Installed packages already include `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, and `@dnd-kit/utilities@3.2.2`.
- Existing backend command `set_workspace_status` only persists status. Backend list order is from `load_workspace_records()`: `ORDER BY datetime(w.created_at) DESC, datetime(w.updated_at) DESC, w.id DESC`.

External best-practice sources:
- dnd-kit `SortableContext` requires `items` in the same sorted order as rendered and may be nested under one `DndContext`: https://dndkit.com/legacy/presets/sortable/sortable-context/
- dnd-kit sortable docs recommend sensors, `sortableKeyboardCoordinates`, `verticalListSortingStrategy`, and `DragOverlay` for scrollable sortable lists: https://dndkit.com/legacy/presets/sortable/overview/
- dnd-kit collision docs recommend `closestCorners` for Kanban-like stacked droppable areas because `closestCenter` can pick the whole column instead of an item: https://dndkit.com/legacy/api-documentation/context-provider/collision-detection-algorithms/
- `DndContext` callbacks do not move items automatically; the app must update React state declaratively in response to drag events: https://dndkit.com/legacy/api-documentation/context-provider/dnd-context/
- Latest dnd-kit React multiple-list guide uses one provider, item sorting via `useSortable`, column droppables for empty columns, and state updates during drag-over/end. It also recommends reverting if drag is canceled after optimistic over-time updates: https://dndkit.com/react/guides/multiple-sortable-lists/

Updated scoped decision:
- The requested Helmor behavior no longer needs arbitrary same-column ordering or middle insertion.
- Use `@dnd-kit/core` directly instead of `@dnd-kit/sortable`: cards are draggable, columns are droppable, and the only accepted placement is target-column top.
- Render a top ghost placeholder while hovering a non-source column. Animate the placeholder height from zero to the dragged card height so existing cards are pushed down smoothly.
- Keep `DragOverlay` mounted and render the presentational card preview inside it for smooth scroll-container-safe dragging and drop animation.
