import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import type { LexicalEditor } from "lexical";
import { $getRoot } from "lexical";
import {
	ArrowUp,
	Check,
	ChevronDown,
	ClipboardList,
	MessageSquareMore,
	Square,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClaudeIcon, OpenAIIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { AgentModelSection, SlashCommandEntry } from "@/lib/api";
import type {
	ComposerCustomTag,
	ResolvedComposerInsertRequest,
} from "@/lib/composer-insert";
import { recordComposerRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import { ComposerButton } from "./button";
import type {
	DeferredToolResponseHandler,
	DeferredToolResponseOptions,
} from "./deferred-tool";
import { DeferredToolPanel } from "./deferred-tool-panel";
import { CustomTagBadgeNode } from "./editor/custom-tag-badge-node";
import { FileBadgeNode } from "./editor/file-badge-node";
import { ImageBadgeNode } from "./editor/image-badge-node";
import { AutoResizePlugin } from "./editor/plugins/auto-resize-plugin";
import { DropFilePlugin } from "./editor/plugins/drop-file-plugin";
import { EditablePlugin } from "./editor/plugins/editable-plugin";
import { EditorRefPlugin } from "./editor/plugins/editor-ref-plugin";
import { FileMentionPlugin } from "./editor/plugins/file-mention-plugin";
import { HasContentPlugin } from "./editor/plugins/has-content-plugin";
import { PasteImagePlugin } from "./editor/plugins/paste-image-plugin";
import { SlashCommandPlugin } from "./editor/plugins/slash-command-plugin";
import { SubmitPlugin } from "./editor/plugins/submit-plugin";
import { $extractComposerContent } from "./editor/utils";
import {
	$appendComposerInsertItems,
	$setEditorContent,
	draftCache,
} from "./editor-ops";

type WorkspaceComposerProps = {
	contextKey: string;
	onSubmit: (
		prompt: string,
		imagePaths: string[],
		filePaths: string[],
		customTags: ComposerCustomTag[],
	) => void;
	disabled?: boolean;
	submitDisabled?: boolean;
	onStop?: () => void;
	sending?: boolean;
	selectedModelId: string | null;
	modelSections: AgentModelSection[];
	onSelectModel: (modelId: string) => void;
	provider?: string;
	effortLevel: string;
	onSelectEffort: (level: string) => void;
	permissionMode: string;
	onChangePermissionMode: (mode: string) => void;
	sendError?: string | null;
	restoreDraft?: string | null;
	restoreImages?: string[];
	restoreFiles?: string[];
	restoreCustomTags?: ComposerCustomTag[];
	restoreNonce?: number;
	pendingInsertRequests?: ResolvedComposerInsertRequest[];
	onPendingInsertRequestsConsumed?: (ids: string[]) => void;
	slashCommands?: readonly SlashCommandEntry[];
	slashCommandsLoading?: boolean;
	slashCommandsError?: boolean;
	onRetrySlashCommands?: () => void;
	workspaceRootPath?: string | null;
	pendingDeferredTool?: PendingDeferredTool | null;
	onDeferredToolResponse?: DeferredToolResponseHandler;
	pendingExitPlanPermissionId?: string | null;
	onPermissionResponse?: (
		permissionId: string,
		behavior: "allow" | "deny",
		options?: { updatedPermissions?: unknown[]; message?: string },
	) => void;
};

const EMPTY_SLASH_COMMANDS: readonly SlashCommandEntry[] = [];
const noopDeferredToolResponse = (
	_deferred: PendingDeferredTool,
	_behavior: "allow" | "deny",
	_options?: DeferredToolResponseOptions,
) => {};
// ---------------------------------------------------------------------------
// Lexical editor config (stable reference — defined outside component)
// ---------------------------------------------------------------------------

const EDITOR_THEME = {
	root: "composer-editor",
	paragraph: "composer-paragraph",
};

function onEditorError(error: Error) {
	console.error("[Composer Lexical]", error);
}

export const WorkspaceComposer = memo(function WorkspaceComposer({
	contextKey,
	onSubmit,
	disabled = false,
	submitDisabled = false,
	onStop,
	sending = false,
	selectedModelId,
	modelSections,
	onSelectModel,
	provider = "claude",
	effortLevel,
	onSelectEffort,
	permissionMode,
	onChangePermissionMode,
	sendError,
	restoreDraft,
	restoreImages = [],
	restoreFiles = [],
	restoreCustomTags = [],
	restoreNonce = 0,
	pendingInsertRequests = [],
	onPendingInsertRequestsConsumed,
	slashCommands = EMPTY_SLASH_COMMANDS,
	slashCommandsLoading = false,
	slashCommandsError = false,
	onRetrySlashCommands,
	workspaceRootPath = null,
	pendingDeferredTool = null,
	onDeferredToolResponse = noopDeferredToolResponse,
	pendingExitPlanPermissionId = null,
	onPermissionResponse,
}: WorkspaceComposerProps) {
	const instanceIdRef = useRef(
		`composer-${Math.random().toString(36).slice(2, 10)}`,
	);
	useEffect(() => {
		recordComposerRender(contextKey, instanceIdRef.current);
	});
	const editorRef = useRef<LexicalEditor | null>(null);
	const consumedInsertRequestIdsRef = useRef<Set<string>>(new Set());
	const [hasContent, setHasContent] = useState(false);
	const isOpus = selectedModelId === "opus-1m" || selectedModelId === "opus";
	const effectiveEffort = useMemo(() => {
		let level = effortLevel;
		if (provider === "codex") {
			if (level === "max") level = "xhigh";
		} else {
			if (level === "xhigh") level = isOpus ? "max" : "high";
			if (level === "minimal") level = "low";
			if (level === "max" && !isOpus) level = "high";
		}
		return level;
	}, [effortLevel, isOpus, provider]);
	const selectedModel = useMemo(() => {
		for (const section of modelSections) {
			for (const option of section.options) {
				if (option.id === selectedModelId) return option;
			}
		}
		return null;
	}, [modelSections, selectedModelId]);
	const hasPendingDeferredTool = pendingDeferredTool !== null;
	const hasPendingPlanReview = pendingExitPlanPermissionId !== null;
	const inputDisabled = disabled || hasPendingDeferredTool;
	const toolbarDisabled =
		disabled || hasPendingDeferredTool || hasPendingPlanReview;
	const sendDisabled =
		disabled ||
		submitDisabled ||
		sending ||
		hasPendingDeferredTool ||
		hasPendingPlanReview ||
		!selectedModel ||
		!hasContent;

	// Lexical initial config — must be a new object per mount for key resets
	const initialConfig = useRef({
		namespace: "WorkspaceComposer",
		theme: EDITOR_THEME,
		nodes: [ImageBadgeNode, FileBadgeNode, CustomTagBadgeNode],
		onError: onEditorError,
	}).current;

	// Save & restore drafts on context switch.
	// Uses Lexical's native EditorState serialization so the full node tree
	// (including badge positions, order, and cursor) is preserved exactly.
	const prevContextKeyRef = useRef(contextKey);
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			const prevKey = prevContextKeyRef.current;
			prevContextKeyRef.current = contextKey;
			const editor = editorRef.current;

			// Save outgoing editor state
			if (editor) {
				let hasContent = false;
				editor.read(() => {
					const c = $extractComposerContent();
					hasContent = Boolean(
						c.text || c.images.length || c.files.length || c.customTags.length,
					);
				});
				if (hasContent) {
					draftCache.set(prevKey, editor.getEditorState().toJSON());
				} else {
					draftCache.delete(prevKey);
				}
			}

			// Restore incoming editor state
			const cached = draftCache.get(contextKey);
			if (cached && editor) {
				editor.setEditorState(editor.parseEditorState(cached));
			} else {
				editor?.update(() => {
					$setEditorContent(
						restoreDraft ?? "",
						restoreImages,
						restoreFiles,
						restoreCustomTags,
					);
				});
			}
		}
	}, [
		contextKey,
		restoreDraft,
		restoreImages,
		restoreFiles,
		restoreCustomTags,
	]);

	// Restore on nonce change (error restore / draft restore)
	const prevNonceRef = useRef(restoreNonce);
	useEffect(() => {
		if (restoreNonce === prevNonceRef.current) return;
		prevNonceRef.current = restoreNonce;
		if (
			!restoreDraft &&
			restoreImages.length === 0 &&
			restoreFiles.length === 0 &&
			restoreCustomTags.length === 0
		)
			return;
		editorRef.current?.update(() => {
			$setEditorContent(
				restoreDraft ?? "",
				restoreImages,
				restoreFiles,
				restoreCustomTags,
			);
		});
	}, [
		restoreNonce,
		restoreDraft,
		restoreImages,
		restoreFiles,
		restoreCustomTags,
	]);

	useEffect(() => {
		const pendingIds = new Set(
			pendingInsertRequests.map((request) => request.id),
		);
		for (const id of consumedInsertRequestIdsRef.current) {
			if (!pendingIds.has(id)) {
				consumedInsertRequestIdsRef.current.delete(id);
			}
		}

		const unconsumed = pendingInsertRequests.filter(
			(request) => !consumedInsertRequestIdsRef.current.has(request.id),
		);
		if (unconsumed.length === 0) {
			return;
		}

		const editor = editorRef.current;
		if (!editor) {
			return;
		}

		const consumedIds: string[] = [];
		editor.update(() => {
			for (const request of unconsumed) {
				$appendComposerInsertItems(request.items);
				consumedInsertRequestIdsRef.current.add(request.id);
				consumedIds.push(request.id);
			}
		});

		if (consumedIds.length > 0) {
			onPendingInsertRequestsConsumed?.(consumedIds);
		}
	}, [onPendingInsertRequestsConsumed, pendingInsertRequests]);

	const handlePlanApprove = useCallback(() => {
		if (!pendingExitPlanPermissionId || !onPermissionResponse) return;
		onChangePermissionMode("bypassPermissions");
		onPermissionResponse(pendingExitPlanPermissionId, "allow", {
			updatedPermissions: [
				{
					type: "setMode",
					mode: "bypassPermissions",
					destination: "session",
				},
			],
		});
	}, [
		onChangePermissionMode,
		pendingExitPlanPermissionId,
		onPermissionResponse,
	]);

	const handlePlanRequestChanges = useCallback(() => {
		if (!pendingExitPlanPermissionId || !onPermissionResponse) return;
		const editor = editorRef.current;
		let feedback = "";
		if (editor) {
			editor.read(() => {
				feedback = $extractComposerContent().text;
			});
		}
		onPermissionResponse(pendingExitPlanPermissionId, "deny", {
			message: feedback.trim(),
		});
		if (editor) {
			editor.update(() => {
				$getRoot().clear();
			});
			draftCache.delete(contextKey);
			setHasContent(false);
		}
	}, [pendingExitPlanPermissionId, onPermissionResponse, contextKey]);

	const handleSubmit = useCallback(() => {
		const editor = editorRef.current;
		if (!editor) return;
		let prompt = "";
		let images: string[] = [];
		let files: string[] = [];
		let customTags: ComposerCustomTag[] = [];
		editor.read(() => {
			const result = $extractComposerContent();
			prompt = result.text;
			images = result.images;
			files = result.files;
			customTags = result.customTags;
		});
		if (
			!prompt &&
			images.length === 0 &&
			files.length === 0 &&
			customTags.length === 0
		)
			return;
		onSubmit(prompt, images, files, customTags);
		editor.update(() => {
			$getRoot().clear();
		});
		draftCache.delete(contextKey);
		setHasContent(false);
	}, [onSubmit, contextKey]);

	return (
		<div
			aria-label="Workspace composer"
			className={cn(
				"flex flex-col rounded-2xl border border-border/40 bg-sidebar px-4 pb-3 pt-3 shadow-[0_-1px_8px_rgba(0,0,0,0.05),0_0_0_1px_rgba(255,255,255,0.02)]",
				inputDisabled &&
					!hasPendingDeferredTool &&
					"cursor-not-allowed opacity-60",
			)}
		>
			<label htmlFor="workspace-input" className="sr-only">
				Workspace input
			</label>

			{hasPendingDeferredTool ? (
				<DeferredToolPanel
					deferred={pendingDeferredTool!}
					disabled={disabled || sending}
					onResponse={onDeferredToolResponse}
				/>
			) : (
				<>
					<LexicalComposer initialConfig={initialConfig}>
						<div className="relative">
							<PlainTextPlugin
								contentEditable={
									<ContentEditable
										id="workspace-input"
										aria-label="Workspace input"
										aria-multiline
										className="composer-editor min-h-[64px] max-h-[240px] resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-foreground outline-none"
									/>
								}
								placeholder={
									<div className="pointer-events-none absolute left-0 top-0 text-[14px] leading-5 tracking-[-0.01em] text-muted-foreground">
										{hasPendingPlanReview
											? "Describe what to change, then click Request Changes"
											: "Ask to make changes, @mention files, run /commands"}
									</div>
								}
								ErrorBoundary={LexicalErrorBoundary}
							/>
						</div>
						<HistoryPlugin />
						<SlashCommandPlugin
							commands={slashCommands}
							isLoading={slashCommandsLoading}
							isError={slashCommandsError}
							onRetry={onRetrySlashCommands}
						/>
						<FileMentionPlugin workspaceRootPath={workspaceRootPath} />
						<SubmitPlugin onSubmit={handleSubmit} disabled={sendDisabled} />
						<PasteImagePlugin />
						<DropFilePlugin />
						<AutoResizePlugin minHeight={64} maxHeight={240} />
						<EditorRefPlugin editorRef={editorRef} />
						<EditablePlugin disabled={inputDisabled} />
						<HasContentPlugin onChange={setHasContent} />
					</LexicalComposer>

					{sendError ? (
						<div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-muted-foreground">
							{sendError}
						</div>
					) : null}

					<div className="mt-2.5 flex items-end justify-between gap-3">
						<div className="flex flex-wrap items-center gap-2">
							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={toolbarDisabled}
									className={cn(
										"flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
										toolbarDisabled &&
											"cursor-not-allowed opacity-45 hover:text-muted-foreground",
									)}
								>
									{selectedModel?.provider === "codex" ? (
										<OpenAIIcon className="size-[14px]" />
									) : (
										<ClaudeIcon className="size-[14px]" />
									)}
									<span>{selectedModel?.label ?? "Select model"}</span>
									<ChevronDown className="size-3 opacity-40" strokeWidth={2} />
								</DropdownMenuTrigger>

								<DropdownMenuContent
									side="top"
									align="start"
									sideOffset={8}
									className="min-w-[17rem]"
								>
									{modelSections.map((section, index) => (
										<DropdownMenuGroup key={section.id}>
											{index > 0 ? <DropdownMenuSeparator /> : null}
											<DropdownMenuLabel>{section.label}</DropdownMenuLabel>
											{section.options.map((option) => (
												<DropdownMenuItem
													key={option.id}
													disabled={toolbarDisabled}
													onClick={() => {
														onSelectModel(option.id);
													}}
													className="flex items-center justify-between gap-3"
												>
													<div className="flex items-center gap-3">
														<span className="text-muted-foreground">
															{option.provider === "codex" ? (
																<OpenAIIcon className="size-4" />
															) : (
																<ClaudeIcon className="size-4" />
															)}
														</span>
														<span className="font-medium">{option.label}</span>
													</div>

													{option.badge ? (
														<span className="rounded-md border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
															{option.badge}
														</span>
													) : null}
												</DropdownMenuItem>
											))}
										</DropdownMenuGroup>
									))}
								</DropdownMenuContent>
							</DropdownMenu>

							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={toolbarDisabled}
									className={cn(
										"flex items-center gap-0.5 px-1 py-0.5 text-[13px] font-medium focus-visible:outline-none",
										toolbarDisabled ? "cursor-not-allowed opacity-45" : null,
									)}
								>
									<span
										className={cn(
											"capitalize",
											effectiveEffort === "max" || effectiveEffort === "xhigh"
												? "effort-max-text"
												: "text-muted-foreground",
										)}
									>
										{effectiveEffort === "xhigh"
											? "Extra High"
											: effectiveEffort}
									</span>
									<ChevronDown
										className="size-3 text-muted-foreground/40"
										strokeWidth={2}
									/>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									side="top"
									align="start"
									sideOffset={8}
									className="min-w-[11rem]"
								>
									<DropdownMenuGroup>
										<DropdownMenuLabel>Effort</DropdownMenuLabel>
										{(provider === "codex"
											? (["minimal", "low", "medium", "high", "xhigh"] as const)
											: isOpus
												? (["low", "medium", "high", "max"] as const)
												: (["low", "medium", "high"] as const)
										).map((level) => (
											<DropdownMenuItem
												key={level}
												disabled={toolbarDisabled}
												onClick={() => onSelectEffort(level)}
												className="flex items-center justify-between gap-3"
											>
												<div className="flex items-center gap-2.5">
													<EffortBrainIcon level={level} />
													<span className="font-medium capitalize">
														{level === "xhigh" ? "Extra High" : level}
													</span>
												</div>
												{level === effectiveEffort ? (
													<span className="text-[11px] text-foreground">✓</span>
												) : null}
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>

							<ComposerButton
								aria-label="Plan mode"
								disabled={toolbarDisabled}
								className={cn(
									"cursor-pointer gap-1.5 rounded-full px-2 py-0.5 text-[13px] font-medium transition-colors",
									permissionMode === "plan" || hasPendingPlanReview
										? "bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.12]"
										: "text-muted-foreground/55 hover:bg-accent/60 hover:text-muted-foreground",
								)}
								onClick={() =>
									onChangePermissionMode(
										permissionMode === "plan" ? "bypassPermissions" : "plan",
									)
								}
							>
								<ClipboardList className="size-[14px]" strokeWidth={1.8} />
								<span>Plan</span>
							</ComposerButton>
						</div>

						<div className="flex items-center gap-2">
							{hasPendingPlanReview ? (
								<>
									<Button
										variant="ghost"
										size="sm"
										aria-label="Request Changes"
										onClick={handlePlanRequestChanges}
										disabled={disabled || !hasContent}
										className="h-7 cursor-pointer gap-1 rounded-lg px-2 text-[12px] text-muted-foreground hover:text-foreground"
									>
										<MessageSquareMore className="size-3.5" strokeWidth={1.8} />
										Request Changes
									</Button>
									<Button
										variant="default"
										size="sm"
										aria-label="Approve"
										onClick={handlePlanApprove}
										disabled={disabled}
										className="h-7 cursor-pointer gap-1 rounded-lg px-2 text-[12px]"
									>
										<Check className="size-3.5" strokeWidth={2} />
										Approve
									</Button>
								</>
							) : sending ? (
								<Button
									variant="destructive"
									size="icon"
									aria-label="Stop"
									onClick={onStop}
									disabled={disabled || submitDisabled}
									className="rounded-[9px]"
								>
									<Square className="size-3 fill-current" strokeWidth={0} />
								</Button>
							) : (
								<Button
									variant="outline"
									size="icon"
									aria-label="Send"
									onClick={handleSubmit}
									disabled={sendDisabled}
									className="rounded-[9px]"
								>
									<ArrowUp className="size-[15px]" strokeWidth={2.2} />
								</Button>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
});

function EffortBrainIcon({ level }: { level: string }) {
	const cls = "size-4 shrink-0";

	if (level === "minimal") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.7"
				/>
			</svg>
		);
	}

	if (level === "low") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.8"
				/>
				<path d="M8.5 8c2-1.5 5-1.5 7 0" opacity="0.5" />
			</svg>
		);
	}

	if (level === "medium") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.85"
				/>
				<path d="M8 7c2-1.5 4-1 6 0" opacity="0.5" />
				<path d="M8.5 11c1.5 1 3.5 1 5 0" opacity="0.5" />
			</svg>
		);
	}

	if (level === "high") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z" />
				<path d="M7.5 7c1.5-1.5 4-2 6.5-0.5" opacity="0.6" />
				<path d="M8 10c1.5 1 3 1.2 5 0" opacity="0.6" />
				<path d="M9 13c1 0.8 2.5 0.8 4 0" opacity="0.6" />
			</svg>
		);
	}

	return (
		<svg
			className={cls}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z" />
			<path d="M7 6.5c2-2 5-2 7.5-0.5" opacity="0.7" />
			<path d="M7.5 9c1.5 1.5 4 1.5 6 0" opacity="0.7" />
			<path d="M8 11.5c1.5 1 3.5 1.2 5 0" opacity="0.7" />
			<path d="M9 14c1 0.7 2.5 0.7 3.5 0" opacity="0.7" />
			<path d="M12 4v2" opacity="0.4" />
		</svg>
	);
}
