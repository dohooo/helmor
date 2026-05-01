import type { WorkspaceRow, WorkspaceStatus } from "@/lib/api";

export type KanbanColumnId = WorkspaceStatus;

export type KanbanColumns = Record<KanbanColumnId, WorkspaceRow[]>;
