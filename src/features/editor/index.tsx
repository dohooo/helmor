import { useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronRight,
	Copy,
	Eye,
	FileCode,
	FileSearch,
	Pencil,
	X,
} from "lucide-react";
import {
	type MutableRefObject,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	type EditorSessionState,
	type EditorViewMode,
	isMarkdownPath,
} from "@/lib/editor-session";
import { helmorQueryKeys } from "@/lib/query-client";
import { describeUnknownError } from "@/lib/workspace-helpers";

// Refined segmented-tab look: no tray, soft glassy pill on the active state.
// Hover only changes text color (no bg) — otherwise hover-on-inactive sits next
// to active-bg and the boundary blurs. Active is the ONLY trigger with a bg.
const SEGMENT_CLASS = [
	"h-5 gap-1 rounded-[5px] px-1.5 py-0 text-[10.5px] font-normal tracking-tight",
	"border-transparent bg-transparent text-muted-foreground/70 shadow-none",
	"hover:bg-transparent hover:text-foreground",
	"data-active:bg-foreground/[0.10] data-active:text-foreground data-active:border-transparent data-active:shadow-none",
	"aria-selected:bg-foreground/[0.10] aria-selected:text-foreground aria-selected:border-transparent aria-selected:shadow-none",
	"dark:data-active:bg-foreground/[0.10] dark:data-active:border-transparent",
	"dark:aria-selected:bg-foreground/[0.10] dark:aria-selected:border-transparent",
	"[&_svg:not([class*='size-'])]:size-2.5",
].join(" ");

type WorkspaceEditorSurfaceProps = {
	editorSession: EditorSessionState;
	editShortcut?: string | null;
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

function getEditorBreadcrumbSegments(
	path: string,
	workspaceRootPath?: string | null,
): string[] {
	const normalizedPath = normalizePath(path);
	const normalizedRoot = workspaceRootPath
		? normalizePath(workspaceRootPath)
		: "";
	const rootPrefix = normalizedRoot.endsWith("/")
		? normalizedRoot
		: `${normalizedRoot}/`;
	const relativePath =
		normalizedRoot && normalizedPath.startsWith(rootPrefix)
			? normalizedPath.slice(rootPrefix.length)
			: normalizedPath;
	const segments = relativePath.split("/").filter(Boolean);
	return segments.length > 0 ? segments : [relativePath || normalizedPath];
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function EditorPathBreadcrumb({
	segments,
	fullPath,
	dirty,
}: {
	segments: string[];
	fullPath: string;
	dirty: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const handleCopyPath = () => {
		if (!navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(fullPath).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		});
	};

	return (
		<div className="flex min-w-0 items-center overflow-hidden text-[13px] font-medium tracking-normal">
			{segments.map((segment, index) => {
				return (
					<span
						key={`${segment}-${index}`}
						className="flex min-w-0 shrink items-center"
					>
						{index > 0 && (
							<ChevronRight
								aria-hidden="true"
								className="mx-1 size-3 shrink-0 text-muted-foreground/45"
								strokeWidth={1.9}
							/>
						)}
						<span className="truncate text-muted-foreground">{segment}</span>
					</span>
				);
			})}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label="Copy absolute path"
				onClick={handleCopyPath}
				className="ml-1 size-5 shrink-0 rounded-sm text-muted-foreground/35 hover:bg-accent/50 hover:text-muted-foreground"
			>
				{copied ? (
					<Check className="size-3" strokeWidth={1.8} />
				) : (
					<Copy className="size-3" strokeWidth={1.8} />
				)}
			</Button>
			{dirty && (
				<span className="ml-1 inline-flex h-5 shrink-0 items-center text-[11px] font-medium tracking-normal text-muted-foreground/55">
					modified
				</span>
			)}
		</div>
	);
}

export function WorkspaceEditorSurface({
	editorSession,
	editShortcut = null,
	workspaceRootPath,
	onChangeSession,
	onExit,
	onError,
}: WorkspaceEditorSurfaceProps) {
	const queryClient = useQueryClient();
	const surfaceRef = useRef<HTMLElement>(null);
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
	const closeLabel =
		editorSession.kind === "diff" ? "Close diff view" : "Close editor view";
	const isMarkdown = isMarkdownPath(editorSession.path);
	const viewMode: EditorViewMode = isMarkdown
		? (editorSession.viewMode ?? "source")
		: "source";
	const showPreview = isMarkdown && viewMode === "preview";
	const canEditFromDiff =
		editorSession.kind === "diff" && editorSession.fileStatus !== "D";
	const canReturnToDiff =
		editorSession.kind === "file" &&
		editorSession.fileStatus !== undefined &&
		editorSession.fileStatus !== "D";
	const breadcrumbSegments = useMemo(
		() => getEditorBreadcrumbSegments(editorSession.path, workspaceRootPath),
		[editorSession.path, workspaceRootPath],
	);
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
				const api = await import("@/lib/api");
				const isDiff = editorSession.kind === "diff";
				const status = editorSession.fileStatus ?? "M";
				const origRef = editorSession.originalRef ?? "HEAD";

				// Fetch original side (from git ref)
				const originalPromise =
					isDiff && status !== "A" && workspaceRootPath
						? api.readFileAtRef(workspaceRootPath, editorSession.path, origRef)
						: Promise.resolve(null);

				// Fetch modified side (from disk or git ref)
				const modifiedPromise = editorSession.modifiedRef
					? workspaceRootPath
						? api.readFileAtRef(
								workspaceRootPath,
								editorSession.path,
								editorSession.modifiedRef,
							)
						: Promise.resolve(null)
					: status !== "D"
						? api.readEditorFile(editorSession.path).then((r) => r.content)
						: Promise.resolve(null);

				const [original, modified] = await Promise.all([
					originalPromise,
					modifiedPromise,
				]);

				if (cancelled) {
					return;
				}

				onChangeSessionRef.current({
					...editorSession,
					originalText:
						editorSession.originalText ??
						(isDiff ? (original ?? "") : (modified ?? "")),
					modifiedText: editorSession.modifiedText ?? modified ?? "",
					dirty: Boolean(editorSession.dirty),
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

	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface) return;
		if (surface.contains(document.activeElement)) return;
		surface.focus({ preventScroll: true });
	}, []);

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

	const handleViewModeChange = (next: string) => {
		if (next !== "source" && next !== "preview") return;
		if (next === viewMode) return;
		onChangeSession({
			...editorSession,
			viewMode: next,
		});
	};

	const handleEnterEditMode = () => {
		if (editorSession.kind !== "diff") return;
		onChangeSession({
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
			viewMode: isMarkdown ? "source" : undefined,
		});
	};

	const handleReturnToDiffMode = () => {
		if (editorSession.kind !== "file") return;
		onChangeSession({
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
			viewMode: isMarkdown ? "source" : undefined,
		});
	};

	const handleSave = async () => {
		const latest = latestSessionRef.current;
		if (latest.kind !== "file" || latest.modifiedText === undefined) {
			return;
		}
		try {
			const api = await import("@/lib/api");
			const result = await api.writeEditorFile(
				latest.path,
				latest.modifiedText,
			);
			onChangeSessionRef.current({
				...latest,
				originalText: latest.modifiedText,
				dirty: false,
				mtimeMs: result.mtimeMs,
			});
			if (workspaceRootPath) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
				});
			}
		} catch (error) {
			const message = describeUnknownError(
				error,
				"Unable to save the selected file.",
			);
			onErrorRef.current?.(message, "Save failed");
		}
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const saveShortcut =
				(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
			if (!saveShortcut) return;
			if (latestSessionRef.current.kind !== "file") return;
			event.preventDefault();
			void handleSave();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	});

	return (
		<section
			ref={surfaceRef}
			aria-label="Workspace editor surface"
			data-focus-scope="editor"
			tabIndex={-1}
			className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground focus:outline-none"
		>
			<div className="flex h-9 items-center border-b border-border">
				{/* Traffic-light inset. macOS: left; Windows / Linux: right. */}
				<TrafficLightSpacer side="left" width={86} />

				<div
					className="flex min-w-0 flex-1 items-center pl-2"
					data-tauri-drag-region
				>
					<EditorPathBreadcrumb
						segments={breadcrumbSegments}
						fullPath={editorSession.path}
						dirty={Boolean(editorSession.dirty)}
					/>
				</div>

				<div className="flex shrink-0 items-center gap-2 pr-2">
					{isMarkdown && (
						<Tabs
							value={viewMode}
							onValueChange={handleViewModeChange}
							aria-label="Markdown view mode"
						>
							{/* No tray: bg-transparent + p-0. Pill highlight only on the active trigger. */}
							<TabsList className="h-5 gap-0 bg-transparent p-0">
								<TabsTrigger value="source" className={SEGMENT_CLASS}>
									<FileCode strokeWidth={1.8} />
									Source
								</TabsTrigger>
								<TabsTrigger value="preview" className={SEGMENT_CLASS}>
									<Eye strokeWidth={1.8} />
									Preview
								</TabsTrigger>
							</TabsList>
						</Tabs>
					)}
					{canEditFromDiff && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleEnterEditMode}
							className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
						>
							<Pencil className="size-3.5" strokeWidth={1.8} />
							<span>Edit</span>
							{editShortcut && (
								<ShortcutDisplay
									hotkey={editShortcut}
									className="ml-1"
									keyClassName="h-4 min-w-4 rounded-[3px] px-1 text-[10px]"
								/>
							)}
						</Button>
					)}
					{canReturnToDiff && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleReturnToDiffMode}
							className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
						>
							<FileSearch className="size-3.5" strokeWidth={1.8} />
							<span>Diff</span>
							{editShortcut && (
								<ShortcutDisplay
									hotkey={editShortcut}
									className="ml-1"
									keyClassName="h-4 min-w-4 rounded-[3px] px-1 text-[10px]"
								/>
							)}
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onExit}
						aria-label={closeLabel}
						className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
					>
						<ShortcutDisplay hotkey="Escape" />
						<X className="size-3.5" strokeWidth={1.8} />
					</Button>
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 bg-background">
				{/* Monaco host stays mounted in preview mode so model + dirty state survive toggling. */}
				<div
					ref={editorHostRef}
					aria-label="Editor canvas"
					className="h-full min-h-0 flex-1"
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
			</div>
		</section>
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
