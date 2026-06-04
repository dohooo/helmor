import { useCallback } from "react";
import { type EditorSessionState, isMarkdownPath } from "@/lib/editor-session";

/**
 * Editor "enter edit mode" toggle + the capability flag that gates it.
 * Extracted verbatim from AppShell (Phase 2 split).
 *
 * `handleEnterEditorEditMode` flips the open editor between its diff and
 * file views (deleted files can't be edited, so it no-ops on `fileStatus`
 * "D"). `canEditEditorSession` mirrors the gate the shortcut handler reads.
 * The session + `changeSession` callback are passed in so the hook stays
 * decoupled from AppShell's editor-session controller wiring.
 */
export function useEditorEditMode({
	editorSession,
	handleEditorSessionChange,
}: {
	editorSession: EditorSessionState | null;
	handleEditorSessionChange: (session: EditorSessionState) => void;
}) {
	const canEditEditorSession =
		(editorSession?.kind === "diff" && editorSession.fileStatus !== "D") ||
		(editorSession?.kind === "file" &&
			editorSession.fileStatus !== undefined &&
			editorSession.fileStatus !== "D");
	const handleEnterEditorEditMode = useCallback(() => {
		if (!editorSession || editorSession.fileStatus === "D") {
			return;
		}
		if (editorSession.kind === "diff") {
			handleEditorSessionChange({
				kind: "file",
				path: editorSession.path,
				line: editorSession.line,
				column: editorSession.column,
				dirty: false,
				inline: editorSession.inline,
				fileStatus: editorSession.fileStatus,
				originalRef: editorSession.originalRef,
				modifiedRef: editorSession.modifiedRef,
				diffOriginalText: editorSession.originalText,
				diffModifiedText: editorSession.modifiedText,
				viewMode: isMarkdownPath(editorSession.path) ? "source" : undefined,
			});
			return;
		}
		if (editorSession.fileStatus === undefined) return;
		handleEditorSessionChange({
			kind: "diff",
			path: editorSession.path,
			line: editorSession.line,
			column: editorSession.column,
			dirty: editorSession.dirty,
			inline: editorSession.inline,
			fileStatus: editorSession.fileStatus,
			originalRef: editorSession.originalRef,
			modifiedRef: editorSession.modifiedRef,
			originalText: editorSession.diffOriginalText,
			modifiedText: editorSession.dirty
				? editorSession.modifiedText
				: editorSession.diffModifiedText,
			diffOriginalText: editorSession.diffOriginalText,
			diffModifiedText: editorSession.diffModifiedText,
			viewMode: isMarkdownPath(editorSession.path) ? "source" : undefined,
		});
	}, [editorSession, handleEditorSessionChange]);

	return { canEditEditorSession, handleEnterEditorEditMode };
}
