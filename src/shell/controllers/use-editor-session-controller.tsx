// Editor session controller: tracks the in-app file/diff editor state and
// owns the open/close/dirty-confirm flow. The conversation/editor view-mode
// switch lives in the selection controller; this one drives the actual
// editor pane state and the workspace fetch on open.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { revealPathInFinder, triggerWorkspaceFetch } from "@/lib/api";
import {
	type DiffOpenOptions,
	type EditorSessionState,
	isMarkdownPath,
	isPathWithinRoot,
} from "@/lib/editor-session";
import { translateSource, useI18n } from "@/lib/i18n";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { useShellEvent } from "@/shell/event-bus";
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
	dialogNode: ReactNode;
};

type DiscardConfirmationRequest = {
	action: string;
	path: string;
	resolve: (confirmed: boolean) => void;
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
	const { t } = useI18n();
	const [editorSession, setEditorSession] = useState<EditorSessionState | null>(
		null,
	);
	const [discardConfirmation, setDiscardConfirmation] =
		useState<DiscardConfirmationRequest | null>(null);

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
			return new Promise<boolean>((resolve) => {
				setDiscardConfirmation({
					action,
					path: editorSession.path,
					resolve,
				});
			});
		},
		[editorSession],
	);

	const resolveDiscardConfirmation = useCallback(
		(confirmed: boolean) => {
			const request = discardConfirmation;
			if (!request) return;
			setDiscardConfirmation(null);
			request.resolve(confirmed);
		},
		[discardConfirmation],
	);

	const reportError = useCallback(
		(
			description: string,
			title = translateSource("miscEditorActionFailed"),
		) => {
			pushToastRef.current(description, title);
		},
		[],
	);

	const openFile = useCallback(
		(path: string, options?: DiffOpenOptions) => {
			if (!workspaceRootPath) {
				pushToastRef.current(
					translateSource("miscEditorRootPathRequired"),
					translateSource("miscEditorUnavailable"),
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
			const open = () => {
				const status = options?.fileStatus ?? "M";
				if (selectedWorkspaceId) {
					triggerWorkspaceFetch(selectedWorkspaceId);
				}

				enterEditorModeRef.current();
				setEditorSession((current) => {
					const samePath = current?.path === path;
					const sameDiffBasis =
						current?.originalRef === nextOriginalRef &&
						current?.modifiedRef === nextModifiedRef;
					if (samePath && current?.kind === "file") {
						return {
							kind: "diff",
							path,
							line: current.line,
							column: current.column,
							inline: status !== "M",
							dirty: current.dirty,
							fileStatus: status,
							originalRef: nextOriginalRef,
							modifiedRef: nextModifiedRef,
							originalText: sameDiffBasis
								? current.diffOriginalText
								: undefined,
							modifiedText: current.dirty
								? current.modifiedText
								: sameDiffBasis
									? current.diffModifiedText
									: undefined,
							diffOriginalText: sameDiffBasis
								? current.diffOriginalText
								: undefined,
							diffModifiedText: sameDiffBasis
								? current.diffModifiedText
								: undefined,
							viewMode: isMarkdownPath(path) ? "source" : undefined,
						};
					}
					return {
						kind: "diff",
						path,
						inline: status !== "M",
						dirty: false,
						fileStatus: status,
						originalRef: nextOriginalRef,
						modifiedRef: nextModifiedRef,
						// Diff click is "see what changed" — default to source even for `.md`.
						viewMode: isMarkdownPath(path) ? "source" : undefined,
					};
				});
			};
			if (editorSession?.dirty && editorSession.path !== path) {
				const confirmed = confirmDiscardEditorChanges(
					"miscDiscardActionOpenAnotherFile",
				);
				if (confirmed === true) {
					open();
					return;
				}
				void confirmed.then((ok) => {
					if (ok) open();
				});
				return;
			}
			open();
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.dirty,
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
					translateSource("miscEditorRootPathRequired"),
					translateSource("miscEditorUnavailable"),
				);
				return;
			}
			if (!isPathWithinRoot(path, workspaceRootPath)) {
				pushToastRef.current(
					translateSource("miscEditorFileOutsideWorkspace"),
					translateSource("miscFileUnavailable"),
				);
				return;
			}
			const open = () => {
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
			};
			if (editorSession?.dirty && editorSession.path !== path) {
				const confirmed = confirmDiscardEditorChanges(
					"miscDiscardActionOpenAnotherFile",
				);
				if (confirmed === true) {
					open();
					return;
				}
				void confirmed.then((ok) => {
					if (ok) open();
				});
				return;
			}
			open();
		},
		[
			confirmDiscardEditorChanges,
			editorSession?.dirty,
			editorSession?.path,
			selectedWorkspaceId,
			workspaceRootPath,
		],
	);

	const changeSession = useCallback((session: EditorSessionState) => {
		setEditorSession(session);
	}, []);

	const exit = useCallback(() => {
		const close = () => {
			exitEditorModeRef.current();
			setEditorSession(null);
		};
		const confirmed = confirmDiscardEditorChanges(
			"miscDiscardActionReturnToChat",
		);
		if (confirmed === true) {
			close();
			return;
		}
		void confirmed.then((ok) => {
			if (ok) close();
		});
	}, [confirmDiscardEditorChanges]);

	// Bus-driven open for callers without direct access to these actions
	// (e.g. the composer task panel's output-file link). Background-task
	// output files often live outside the workspace (/tmp, ~/.claude);
	// the in-app editor only opens workspace files, so fall back to
	// revealing the file in Finder instead of surfacing an error toast.
	useShellEvent("open-file-in-editor", (event) => {
		if (workspaceRootPath && isPathWithinRoot(event.path, workspaceRootPath)) {
			openFileReference(event.path, event.line);
			return;
		}
		void revealPathInFinder(event.path);
	});

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
		dialogNode: (
			<ConfirmDialog
				open={discardConfirmation !== null}
				onOpenChange={(open) => {
					if (!open) resolveDiscardConfirmation(false);
				}}
				title="discardUnsavedChanges"
				description={
					<span className="block">
						<span className="block">{t("haveUnsavedChanges")}</span>
						<span className="mt-2 block">
							{t("discardThem")}{" "}
							{t(discardConfirmation?.action ?? "miscDiscardActionContinue")}?
						</span>
					</span>
				}
				confirmLabel="discard"
				onConfirm={() => resolveDiscardConfirmation(true)}
			/>
		),
	};
}
