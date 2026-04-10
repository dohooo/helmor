import { X } from "lucide-react";
import {
	type MutableRefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { EditorSessionState } from "@/lib/editor-session";
import { describeUnknownError } from "@/lib/workspace-helpers";
import { Button } from "./ui/button";
import { KbdKey } from "./ui/kbd-key";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type WorkspaceEditorSurfaceProps = {
	editorSession: EditorSessionState;
	workspaceRootPath?: string | null;
	onChangeSession: (session: EditorSessionState) => void;
	onExit: () => void;
	onError?: (description: string, title?: string) => void;
};

type SurfaceStatus =
	| { kind: "loading" }
	| { kind: "ready" }
	| { kind: "error"; message: string };

type MonacoRuntimeModule = typeof import("@/lib/monaco-runtime");
type FileController = Awaited<
	ReturnType<MonacoRuntimeModule["createFileEditor"]>
>;
type DiffController = Awaited<
	ReturnType<MonacoRuntimeModule["createDiffEditor"]>
>;

export function WorkspaceEditorSurface({
	editorSession,
	workspaceRootPath: _workspaceRootPath,
	onChangeSession,
	onExit,
	onError,
}: WorkspaceEditorSurfaceProps) {
	const editorHostRef = useRef<HTMLDivElement>(null);
	const fileControllerRef = useRef<FileController | null>(null);
	const diffControllerRef = useRef<DiffController | null>(null);
	const changeSubscriptionRef = useRef<{ dispose(): void } | null>(null);
	const latestSessionRef = useRef(editorSession);
	const onChangeSessionRef = useRef(onChangeSession);
	const onErrorRef = useRef(onError);
	const applyValueRef = useRef(false);
	const buildRequestIdRef = useRef(0);
	const [surfaceStatus, setSurfaceStatus] = useState<SurfaceStatus>({
		kind: "ready",
	});
	latestSessionRef.current = editorSession;
	onChangeSessionRef.current = onChangeSession;
	onErrorRef.current = onError;

	const canRenderFile =
		editorSession.kind === "file" &&
		editorSession.originalText !== undefined &&
		editorSession.modifiedText !== undefined;
	const canRenderDiff =
		editorSession.kind === "diff" &&
		editorSession.originalText !== undefined &&
		editorSession.modifiedText !== undefined;

	useEffect(() => {
		if (
			(editorSession.kind === "file" && canRenderFile) ||
			(editorSession.kind === "diff" && canRenderDiff)
		) {
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				const { readEditorFile } = await import("@/lib/api");
				const response = await readEditorFile(editorSession.path);

				if (cancelled) {
					return;
				}

				onChangeSessionRef.current({
					...editorSession,
					originalText: editorSession.originalText ?? response.content,
					modifiedText: editorSession.modifiedText ?? response.content,
					dirty: Boolean(editorSession.dirty),
					mtimeMs: response.mtimeMs,
				});
			} catch (error) {
				if (cancelled) {
					return;
				}

				const message = describeUnknownError(
					error,
					"Unable to load the selected file.",
				);
				setSurfaceStatus({ kind: "error", message });
				onErrorRef.current?.(message, "File open failed");
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [canRenderDiff, canRenderFile, editorSession]);

	// Dispose editors on unmount (separate from the switching effect so the
	// fast-path can skip cleanup without leaking on unmount).
	useEffect(() => {
		return () => {
			disposeControllers({
				fileControllerRef,
				diffControllerRef,
				changeSubscriptionRef,
			});
		};
	}, []);

	// useLayoutEffect: run model swap BEFORE browser paint to avoid flicker.
	// The fast path returns NO cleanup — we keep the editor instance alive across
	// path changes. Only the slow path (first creation / kind change) disposes.
	useLayoutEffect(() => {
		const host = editorHostRef.current;
		if (!host) {
			return;
		}

		// ── Fast path: reuse existing file editor on path change ──
		// Runs even when content isn't loaded yet — switchFile uses Monaco model cache.
		if (editorSession.kind === "file" && fileControllerRef.current) {
			const content = editorSession.modifiedText ?? editorSession.originalText;
			const switched = fileControllerRef.current.switchFile(
				editorSession.path,
				content,
				editorSession.line,
				editorSession.column,
			);

			if (switched) {
				// Sync parent state from cached model when content wasn't in state yet
				if (content === undefined) {
					const cachedContent = fileControllerRef.current.getValue();
					onChangeSessionRef.current({
						...latestSessionRef.current,
						originalText: cachedContent,
						modifiedText: cachedContent,
						dirty: false,
					});
				}

				changeSubscriptionRef.current?.dispose();
				changeSubscriptionRef.current = null;
				changeSubscriptionRef.current =
					fileControllerRef.current.onDidChangeModelContent((value) => {
						if (applyValueRef.current) {
							return;
						}
						const latest = latestSessionRef.current;
						const nextDirty = value !== (latest.originalText ?? "");
						if (
							value === latest.modifiedText &&
							nextDirty === Boolean(latest.dirty)
						) {
							return;
						}
						onChangeSessionRef.current({
							...latest,
							kind: "file",
							modifiedText: value,
							dirty: nextDirty,
						});
					});
			}

			// No cleanup — editor stays alive. Unmount cleanup handles disposal.
			return;
		}

		// ── Guard: need content for initial editor creation ──
		if (!canRenderFile && !canRenderDiff) {
			return;
		}

		// ── Slow path: first render or kind change ──
		const requestId = buildRequestIdRef.current + 1;
		buildRequestIdRef.current = requestId;
		let disposed = false;

		disposeControllers({
			fileControllerRef,
			diffControllerRef,
			changeSubscriptionRef,
		});
		host.replaceChildren();

		if (editorSession.kind === "file") {
			void (async () => {
				try {
					const { createFileEditor } = await import("@/lib/monaco-runtime");
					const controller = await createFileEditor({
						container: host,
						path: editorSession.path,
						content:
							editorSession.modifiedText ?? editorSession.originalText ?? "",
						line: editorSession.line,
						column: editorSession.column,
					});

					if (disposed || requestId !== buildRequestIdRef.current) {
						controller.dispose();
						return;
					}

					fileControllerRef.current = controller;
					changeSubscriptionRef.current = controller.onDidChangeModelContent(
						(value) => {
							if (applyValueRef.current) {
								return;
							}
							const latest = latestSessionRef.current;
							const nextDirty = value !== (latest.originalText ?? "");
							if (
								value === latest.modifiedText &&
								nextDirty === Boolean(latest.dirty)
							) {
								return;
							}
							onChangeSessionRef.current({
								...latest,
								kind: "file",
								modifiedText: value,
								dirty: nextDirty,
							});
						},
					);
					setSurfaceStatus({ kind: "ready" });
				} catch (error) {
					const message = describeUnknownError(
						error,
						"Unable to start the editor.",
					);
					setSurfaceStatus({ kind: "error", message });
					onErrorRef.current?.(message, "Editor startup failed");
				}
			})();
		} else {
			void (async () => {
				try {
					const { createDiffEditor } = await import("@/lib/monaco-runtime");
					const controller = await createDiffEditor({
						container: host,
						path: editorSession.path,
						originalText: editorSession.originalText ?? "",
						modifiedText: editorSession.modifiedText ?? "",
						inline: Boolean(editorSession.inline),
					});

					if (disposed || requestId !== buildRequestIdRef.current) {
						controller.dispose();
						return;
					}

					diffControllerRef.current = controller;
					setSurfaceStatus({ kind: "ready" });
				} catch (error) {
					const message = describeUnknownError(
						error,
						"Unable to start the review surface.",
					);
					setSurfaceStatus({ kind: "error", message });
					onErrorRef.current?.(message, "Review surface failed");
				}
			})();
		}

		return () => {
			// Only guard against stale async completions — do NOT dispose the
			// editor here.  The slow path's entry block already calls
			// disposeControllers before creating a new editor (handles kind
			// changes), and the separate unmount effect handles final cleanup.
			disposed = true;
		};
	}, [canRenderDiff, canRenderFile, editorSession.kind, editorSession.path]);

	useEffect(() => {
		if (
			editorSession.kind !== "file" ||
			!fileControllerRef.current ||
			editorSession.modifiedText === undefined
		) {
			return;
		}

		applyValueRef.current = true;
		try {
			fileControllerRef.current.setValue(editorSession.modifiedText);
		} finally {
			applyValueRef.current = false;
		}
	}, [editorSession.kind, editorSession.modifiedText]);

	useEffect(() => {
		if (editorSession.kind !== "file" || !fileControllerRef.current) {
			return;
		}

		fileControllerRef.current.revealPosition(
			editorSession.line,
			editorSession.column,
		);
	}, [editorSession.column, editorSession.kind, editorSession.line]);

	useEffect(() => {
		if (
			editorSession.kind !== "diff" ||
			!diffControllerRef.current ||
			editorSession.originalText === undefined ||
			editorSession.modifiedText === undefined
		) {
			return;
		}

		diffControllerRef.current.setTexts({
			originalText: editorSession.originalText,
			modifiedText: editorSession.modifiedText,
			inline: Boolean(editorSession.inline),
		});
	}, [
		editorSession.inline,
		editorSession.kind,
		editorSession.modifiedText,
		editorSession.originalText,
	]);

	// ESC key to exit
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onExit();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onExit]);

	return (
		<section
			aria-label="Workspace editor surface"
			className="flex h-full min-h-0 flex-col overflow-hidden bg-[#161514] text-[#cccccc]"
		>
			<div
				className="flex h-9 items-center border-b border-[#2b2b2b]"
				data-tauri-drag-region
			>
				{/* Traffic-light inset: macOS stoplight buttons sit at x=16, ~70px total width */}
				<div className="w-[86px] shrink-0" data-tauri-drag-region />

				<div className="min-w-0 flex-1" data-tauri-drag-region />

				<div className="flex shrink-0 items-center pr-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								onClick={onExit}
								aria-label="Close"
								className="aspect-square h-full text-[#8f8f8f] hover:bg-transparent hover:text-white"
							>
								<X className="size-3.5" strokeWidth={1.8} />
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							sideOffset={6}
							className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
						>
							<span className="leading-none">Close</span>
							<KbdKey name="Esc" className="ml-1" />
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 bg-[#161514]">
				<div
					ref={editorHostRef}
					aria-label="Editor canvas"
					className="h-full min-h-0 flex-1"
				/>

				{surfaceStatus.kind === "error" && (
					<div className="absolute inset-0 flex items-center justify-center bg-[#161514]">
						<SurfaceMessage message={surfaceStatus.message} />
					</div>
				)}
			</div>
		</section>
	);
}

function SurfaceMessage({ message }: { message: string }) {
	return <p className="text-[13px] leading-5 text-[#8f8f8f]">{message}</p>;
}

function disposeControllers({
	fileControllerRef,
	diffControllerRef,
	changeSubscriptionRef,
}: {
	fileControllerRef: MutableRefObject<FileController | null>;
	diffControllerRef: MutableRefObject<DiffController | null>;
	changeSubscriptionRef: MutableRefObject<{ dispose(): void } | null>;
}) {
	changeSubscriptionRef.current?.dispose();
	changeSubscriptionRef.current = null;
	fileControllerRef.current?.dispose();
	fileControllerRef.current = null;
	diffControllerRef.current?.dispose();
	diffControllerRef.current = null;
}
