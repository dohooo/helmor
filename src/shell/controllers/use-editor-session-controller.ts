// Editor session controller: tracks the in-app file/diff editor state and
// owns the open/close/dirty-confirm flow. The conversation/editor view-mode
// switch lives in the selection controller; this one drives the actual
// editor pane state and the workspace fetch on open.
import { useCallback, useEffect, useState } from "react";
import { triggerWorkspaceFetch } from "@/lib/api";
import {
	type DiffOpenOptions,
	type EditorSessionState,
	isMarkdownPath,
	isPathWithinRoot,
} from "@/lib/editor-session";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";

export type EditorSessionActions = {
	openFile(path: string, options?: DiffOpenOptions): void;
	openFileReference(path: string, line?: number, column?: number): void;
	changeSession(session: EditorSessionState): void;
	exit(): void;
	reportError(description: string, title?: string): void;
};

export type EditorSessionController = {
	state: { editorSession: EditorSessionState | null };
	actions: EditorSessionActions;
};

export type EditorSessionControllerDeps = {
	pushToast: PushWorkspaceToast;
	workspaceRootPath: string | null;
	selectedWorkspaceId: string | null;
	// Mode transitions are coordinated through the selection controller —
	// the editor controller asks AppShell to enter or exit editor mode here.
	enterEditorMode(): void;
	exitEditorMode(): void;
};

export function useEditorSessionController(
	deps: EditorSessionControllerDeps,
): EditorSessionController {
	const {
		pushToast,
		workspaceRootPath,
		selectedWorkspaceId,
		enterEditorMode,
		exitEditorMode,
	} = deps;
	const [editorSession, setEditorSession] = useState<EditorSessionState | null>(
		null,
	);

	const enterEditorModeRef = useLatestRef(enterEditorMode);
	const exitEditorModeRef = useLatestRef(exitEditorMode);
	const pushToastRef = useLatestRef(pushToast);

	// If the open editor file falls outside the workspace root (e.g. the
	// user switched to a different workspace), bounce back to the chat.
	useEffect(() => {
		if (!editorSession) return;
		if (isPathWithinRoot(editorSession.path, workspaceRootPath)) return;
		exitEditorModeRef.current();
		setEditorSession(null);
	}, [editorSession, workspaceRootPath]);

	const confirmDiscardEditorChanges = useCallback(
		(action: string) => {
			if (!editorSession?.dirty) return true;
			if (typeof window === "undefined") return false;
			return window.confirm(
				`You have unsaved changes in ${editorSession.path}. Discard them and ${action}?`,
			);
		},
		[editorSession],
	);

	const reportError = useCallback(
		(description: string, title = "Editor action failed") => {
			pushToastRef.current(description, title);
		},
		[],
	);

	const openFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			if (!workspaceRootPath) {
				pushToastRef.current(
					"Open a workspace with a resolved root path before using the in-app editor.",
					"Editor unavailable",
				);
				return;
			}
			const nextOriginalRef = options?.originalRef;
			const nextModifiedRef = options?.modifiedRef;
			// Same path can appear in multiple inspector areas (Staged / Unstaged /
			// Remote) with different diff bases — short-circuit only when the
			// destination matches the current view byte-for-byte. Comparing path
			// alone would freeze the editor on the first-opened area's bases.
			if (
				editorSession?.kind === "diff" &&
				editorSession.path === path &&
				editorSession.originalRef === nextOriginalRef &&
				editorSession.modifiedRef === nextModifiedRef
			) {
				return;
			}
			if (!confirmDiscardEditorChanges("open another file")) return;

			const status = options?.fileStatus ?? "M";
			if (selectedWorkspaceId) {
				triggerWorkspaceFetch(selectedWorkspaceId);
			}

			enterEditorModeRef.current();
			setEditorSession({
				kind: "diff",
				path,
				inline: status !== "M",
				dirty: false,
				fileStatus: status,
				originalRef: nextOriginalRef,
				modifiedRef: nextModifiedRef,
				// Diff click is "see what changed" — default to source even for `.md`.
				viewMode: isMarkdownPath(path) ? "source" : undefined,
			});
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.kind,
			editorSession?.path,
			editorSession?.originalRef,
			editorSession?.modifiedRef,
			selectedWorkspaceId,
			workspaceRootPath,
		],
	);

	const openFileReference = useCallback(
		(path: string, line?: number, column?: number) => {
			if (!workspaceRootPath) {
				pushToastRef.current(
					"Open a workspace with a resolved root path before using the in-app editor.",
					"Editor unavailable",
				);
				return;
			}
			if (!isPathWithinRoot(path, workspaceRootPath)) {
				pushToastRef.current(
					"Only files inside the current workspace can be opened in the in-app editor.",
					"File unavailable",
				);
				return;
			}
			if (
				editorSession?.path !== path &&
				!confirmDiscardEditorChanges("open another file")
			) {
				return;
			}
			if (selectedWorkspaceId) {
				triggerWorkspaceFetch(selectedWorkspaceId);
			}

			enterEditorModeRef.current();
			setEditorSession((current) => {
				const samePath = current?.path === path;
				// `originalText` carries area-specific bytes when `current` is a
				// diff session (HEAD/INDEX content) — reusing those for a file
				// session would make dirty-tracking compare against a git ref,
				// not the working-tree, and a Save could clobber unstaged work.
				// Only reuse texts when we're staying inside a `file` session.
				const sameFile = samePath && current?.kind === "file";
				// Chat-link open of markdown defaults to preview; preserve a user
				// toggle if the same file is reopened. The view-mode preference
				// is presentation-only, so the loose samePath check is safe even
				// across kind transitions.
				const viewMode = isMarkdownPath(path)
					? samePath && current?.viewMode
						? current.viewMode
						: "preview"
					: undefined;
				return {
					kind: "file",
					path,
					line,
					column,
					dirty: sameFile ? current.dirty : false,
					originalText: sameFile ? current.originalText : undefined,
					modifiedText: sameFile ? current.modifiedText : undefined,
					mtimeMs: sameFile ? current.mtimeMs : undefined,
					viewMode,
				};
			});
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.path,
			selectedWorkspaceId,
			workspaceRootPath,
		],
	);

	const changeSession = useCallback((session: EditorSessionState) => {
		setEditorSession(session);
	}, []);

	const exit = useCallback(() => {
		if (!confirmDiscardEditorChanges("return to chat")) return;
		exitEditorModeRef.current();
		setEditorSession(null);
	}, [confirmDiscardEditorChanges]);

	const actions = useStableActions<EditorSessionActions>({
		openFile,
		openFileReference,
		changeSession,
		exit,
		reportError,
	});

	return {
		state: { editorSession },
		actions,
	};
}
