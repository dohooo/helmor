import { useQueryClient } from "@tanstack/react-query";
import { Columns2, Pin, X } from "lucide-react";
import {
	type MutableRefObject,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileIcon } from "@/features/file-browser/file-icon";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import { readEditorFile, writeEditorFile } from "@/lib/api";
import {
	type EditorSessionState,
	type EditorViewMode,
	isMarkdownPath,
} from "@/lib/editor-session";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { describeUnknownError } from "@/lib/workspace-helpers";

type WorkspaceEditorSurfaceProps = {
	editorSession: EditorSessionState;
	workspaceRootPath?: string | null;
	/**
	 * True when the active file has uncommitted (or branch-relative) changes.
	 * When false, the Diff segment is disabled — opening a diff on an unchanged
	 * file produces a phantom trailing-newline-only diff that confuses users.
	 */
	fileHasChanges?: boolean;
	onChangeSession: (session: EditorSessionState) => void;
	onExit: () => void;
	onError?: (description: string, title?: string) => void;
};

type SurfaceStatus =
	| { kind: "loading" }
	| { kind: "ready" }
	| { kind: "error"; message: string };

type MtimeConflict = {
	path: string;
	currentMtimeMs: number;
};

type MonacoRuntimeModule = typeof import("@/lib/monaco-runtime");
type FileController = Awaited<
	ReturnType<MonacoRuntimeModule["createFileEditor"]>
>;
type DiffController = Awaited<
	ReturnType<MonacoRuntimeModule["createDiffEditor"]>
>;

export function WorkspaceEditorSurface({
	editorSession,
	workspaceRootPath,
	fileHasChanges = false,
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
	const [, setSaveStatus] = useState<"idle" | "saving" | "saved" | "conflict">(
		"idle",
	);
	const [mtimeConflict, setMtimeConflict] = useState<MtimeConflict | null>(
		null,
	);
	const { settings } = useSettings();
	const queryClient = useQueryClient();
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
	const isMarkdown = isMarkdownPath(editorSession.path);
	const viewMode: EditorViewMode = isMarkdown
		? (editorSession.viewMode ?? "source")
		: "source";
	const showPreview = isMarkdown && viewMode === "preview";
	const previewContent = useMemo(() => {
		if (!showPreview) return "";
		return editorSession.modifiedText ?? editorSession.originalText ?? "";
	}, [showPreview, editorSession.modifiedText, editorSession.originalText]);

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
				const isDiff = editorSession.kind === "diff";
				const status = editorSession.fileStatus ?? "M";
				const origRef = editorSession.originalRef ?? "HEAD";

				// Fetch original side (from git ref)
				const originalPromise =
					isDiff && status !== "A" && workspaceRootPath
						? (await import("@/lib/api")).readFileAtRef(
								workspaceRootPath,
								editorSession.path,
								origRef,
							)
						: Promise.resolve(null);

				// Fetch modified side (from disk or git ref)
				const modifiedPromise: Promise<
					string | null | { content: string; mtimeMs: number }
				> = editorSession.modifiedRef
					? workspaceRootPath
						? (await import("@/lib/api")).readFileAtRef(
								workspaceRootPath,
								editorSession.path,
								editorSession.modifiedRef,
							)
						: Promise.resolve(null)
					: status !== "D"
						? readEditorFile(editorSession.path).then((r) => ({
								content: r.content,
								mtimeMs: r.mtimeMs,
							}))
						: Promise.resolve(null);

				const [original, modified] = await Promise.all([
					originalPromise,
					modifiedPromise,
				]);
				const modifiedContent =
					typeof modified === "object" && modified !== null
						? modified.content
						: modified;
				const modifiedMtimeMs =
					typeof modified === "object" && modified !== null
						? modified.mtimeMs
						: null;

				if (cancelled) {
					return;
				}

				onChangeSessionRef.current({
					...editorSession,
					originalText:
						editorSession.originalText ??
						(isDiff ? (original ?? "") : (modifiedContent ?? "")),
					modifiedText: editorSession.modifiedText ?? modifiedContent ?? "",
					dirty: Boolean(editorSession.dirty),
					mtimeMs:
						editorSession.kind === "file"
							? (editorSession.mtimeMs ?? modifiedMtimeMs)
							: editorSession.mtimeMs,
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
	}, [canRenderDiff, canRenderFile, editorSession, workspaceRootPath]);

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

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onExit();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onExit]);

	// ⌘⇧V toggles markdown preview, mirroring VS Code's "Markdown: Toggle Preview".
	useEffect(() => {
		if (!isMarkdown) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			const isToggle =
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				event.key.toLowerCase() === "v";
			if (!isToggle) return;
			event.preventDefault();
			const next: EditorViewMode =
				viewMode === "preview" ? "source" : "preview";
			onChangeSessionRef.current({
				...latestSessionRef.current,
				viewMode: next,
			});
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isMarkdown, viewMode]);

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

	const saveCurrentFile = useCallback(
		async (overwrite = false) => {
			const latest = latestSessionRef.current;
			if (latest.kind !== "file" || latest.modifiedText === undefined) {
				return;
			}
			setSaveStatus("saving");
			try {
				const outcome = await writeEditorFile(
					latest.path,
					latest.modifiedText,
					{
						expectedMtimeMs: latest.mtimeMs ?? undefined,
						overwrite,
					},
				);
				if (outcome.kind === "conflict") {
					setMtimeConflict({
						path: outcome.path,
						currentMtimeMs: outcome.currentMtimeMs,
					});
					setSaveStatus("conflict");
					return;
				}
				setMtimeConflict(null);
				setSaveStatus("saved");
				if (workspaceRootPath) {
					void queryClient.invalidateQueries({
						queryKey: ["workspaceDirectory", workspaceRootPath],
					});
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
					});
				}
				onChangeSessionRef.current({
					...latest,
					originalText: latest.modifiedText,
					modifiedText: latest.modifiedText,
					mtimeMs: outcome.mtimeMs,
					dirty: false,
				});
			} catch (error) {
				const message = describeUnknownError(
					error,
					"Unable to save the selected file.",
				);
				setSaveStatus("idle");
				onErrorRef.current?.(message, "File save failed");
			}
		},
		[queryClient, workspaceRootPath],
	);

	const shortcutHandlers = useMemo<ShortcutHandler[]>(
		() => [
			{
				id: "editor.save",
				callback: () => {
					void saveCurrentFile(false);
				},
				enabled: editorSession.kind === "file",
			},
		],
		[editorSession.kind, saveCurrentFile],
	);
	useAppShortcuts({
		overrides: settings.shortcuts,
		handlers: shortcutHandlers,
	});

	useEffect(() => {
		if (
			!settings.editorAutosave ||
			editorSession.kind !== "file" ||
			!editorSession.dirty ||
			editorSession.modifiedText === undefined
		) {
			return;
		}
		const id = window.setTimeout(() => {
			void saveCurrentFile(false);
		}, 1200);
		return () => window.clearTimeout(id);
	}, [
		editorSession.dirty,
		editorSession.kind,
		editorSession.modifiedText,
		saveCurrentFile,
		settings.editorAutosave,
	]);

	const handleReloadConflict = useCallback(async () => {
		const latest = latestSessionRef.current;
		try {
			const response = await readEditorFile(latest.path);
			setMtimeConflict(null);
			setSaveStatus("idle");
			onChangeSessionRef.current({
				...latest,
				kind: "file",
				originalText: response.content,
				modifiedText: response.content,
				mtimeMs: response.mtimeMs,
				dirty: false,
			});
		} catch (error) {
			const message = describeUnknownError(
				error,
				"Unable to reload the selected file.",
			);
			onErrorRef.current?.(message, "File reload failed");
		}
	}, []);

	const handleFileDiffModeChange = (next: string) => {
		if (next !== "file" && next !== "diff") return;
		if (next === editorSession.kind) return;
		if (next === "diff" && !fileHasChanges) return;
		if (
			editorSession.kind === "file" &&
			editorSession.dirty &&
			next === "diff" &&
			typeof window !== "undefined" &&
			!window.confirm("Discard unsaved changes and open the saved diff?")
		) {
			return;
		}
		onChangeSession({
			...editorSession,
			kind: next,
			dirty: false,
			originalText: undefined,
			modifiedText: undefined,
			inline:
				next === "diff" ? (editorSession.fileStatus ?? "M") !== "M" : undefined,
			viewMode: isMarkdownPath(editorSession.path) ? "source" : undefined,
		});
	};

	const handleViewModeChange = (next: string) => {
		if (next !== "source" && next !== "preview") return;
		if (next === viewMode) return;
		onChangeSession({
			...editorSession,
			viewMode: next,
		});
	};

	return (
		<section
			aria-label="Workspace editor surface"
			data-focus-scope="editor"
			className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
		>
			<div
				className="flex h-7 items-center border-y border-border/60 px-4"
				data-tauri-drag-region
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<FileIcon
						name={fileBasename(editorSession.path)}
						kind="file"
						className="size-3"
					/>
					<span
						className="truncate font-mono text-[11px] italic text-muted-foreground"
						title={editorSession.path}
					>
						{fileBasename(editorSession.path)}
					</span>
				</div>

				<div className="min-w-0 flex-1" data-tauri-drag-region />

				<div className="flex shrink-0 items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => {
									const next = editorSession.kind === "file" ? "diff" : "file";
									handleFileDiffModeChange(next);
								}}
								disabled={editorSession.kind === "file" && !fileHasChanges}
								aria-pressed={editorSession.kind === "diff"}
								className={cn(
									"inline-flex h-[18px] cursor-pointer items-center rounded-[4px] px-1.5 text-[10.5px] font-normal tracking-tight text-muted-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
									editorSession.kind === "diff" &&
										"bg-foreground/[0.10] text-foreground",
									editorSession.kind === "file" &&
										!fileHasChanges &&
										"cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground/80",
								)}
							>
								{editorSession.kind === "diff" ? "Diff" : "Raw"}
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" sideOffset={4}>
							{editorSession.kind === "diff"
								? "Switch to raw file"
								: fileHasChanges
									? "Switch to diff view"
									: "No changes to diff"}
						</TooltipContent>
					</Tooltip>
					{isMarkdown && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() =>
										handleViewModeChange(
											viewMode === "preview" ? "source" : "preview",
										)
									}
									aria-pressed={viewMode === "preview"}
									className={cn(
										"inline-flex h-[18px] cursor-pointer items-center rounded-[4px] px-1.5 text-[10.5px] font-normal tracking-tight text-muted-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
										viewMode === "preview" &&
											"bg-foreground/[0.10] text-foreground",
									)}
								>
									{viewMode === "preview" ? "Preview" : "Source"}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" sideOffset={4}>
								{viewMode === "preview"
									? "Switch to source"
									: "Switch to preview"}
							</TooltipContent>
						</Tooltip>
					)}
					<div className="ml-1 flex items-center gap-0.5">
						<WindowAction label="Pin tab" icon={Pin} />
						<WindowAction label="Split panel" icon={Columns2} />
						<WindowAction label="Close" icon={X} />
					</div>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 bg-background">
				{/* Monaco host stays mounted in preview mode so model + dirty state survive toggling. */}
				<div
					ref={editorHostRef}
					aria-label="Editor canvas"
					className="helmor-editor-canvas h-full min-h-0 flex-1 bg-background"
					aria-hidden={showPreview}
					style={showPreview ? { visibility: "hidden" } : undefined}
				/>

				{showPreview && (
					<div
						aria-label="Markdown preview"
						className="absolute inset-0 overflow-y-auto bg-background"
					>
						<div className="conversation-markdown mx-auto max-w-3xl break-words px-8 py-6 text-[13px] leading-6 text-foreground">
							<Suspense
								fallback={
									<pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
										{previewContent}
									</pre>
								}
							>
								<LazyStreamdown
									className="conversation-streamdown"
									mode="static"
								>
									{previewContent}
								</LazyStreamdown>
							</Suspense>
						</div>
					</div>
				)}

				{surfaceStatus.kind === "error" && (
					<div className="absolute inset-0 flex items-center justify-center bg-background">
						<SurfaceMessage message={surfaceStatus.message} />
					</div>
				)}
				{mtimeConflict ? (
					<div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80">
						<div className="w-[340px] rounded-lg border border-border bg-popover p-4 shadow-lg">
							<h2 className="text-[13px] font-semibold text-foreground">
								File changed on disk
							</h2>
							<p className="mt-2 text-[12px] leading-5 text-muted-foreground">
								The file has been modified since this tab loaded. Reload it, or
								overwrite the version on disk.
							</p>
							<div className="mt-4 flex justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setMtimeConflict(null);
										setSaveStatus("idle");
									}}
								>
									Cancel
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void handleReloadConflict()}
								>
									Reload
								</Button>
								<Button
									type="button"
									variant="default"
									size="sm"
									onClick={() => void saveCurrentFile(true)}
								>
									Overwrite
								</Button>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</section>
	);
}

function fileBasename(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function WindowAction({
	label,
	icon: Icon,
}: {
	label: string;
	icon: typeof Pin;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
				>
					<Icon strokeWidth={1.8} className="size-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" sideOffset={4}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}

function SurfaceMessage({ message }: { message: string }) {
	return (
		<p className="text-[13px] leading-5 text-muted-foreground">{message}</p>
	);
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
