import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import type { LexicalEditor, SerializedEditorState } from "lexical";
import { $getRoot } from "lexical";
import {
	ArrowUp,
	Check,
	ChevronDown,
	ClipboardList,
	Clock3,
	Layers,
	MessageSquareMore,
	Plus,
	Square,
	Zap,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelIcon } from "@/components/model-icon";
import { Button } from "@/components/ui/button";
import {
	ButtonGroup,
	ButtonGroupSeparator,
} from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShimmerText } from "@/components/ui/shimmer-text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import { humanizeBranch } from "@/features/navigation/shared";
import { normalizeShortcutEvent } from "@/features/shortcuts/format";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type {
	AgentModelSection,
	CandidateDirectory,
	SlashCommandEntry,
} from "@/lib/api";
import type {
	ComposerCustomTag,
	ResolvedComposerInsertRequest,
} from "@/lib/composer-insert";
import { recordComposerRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import { clampEffort } from "@/lib/workspace-helpers";
import { ComposerButton } from "./button";
import { ContextBar } from "./context-bar";
import { ContextUsageRing } from "./context-usage-ring";
import type {
	DeferredToolResponseHandler,
	DeferredToolResponseOptions,
} from "./deferred-tool";
import { DeferredToolPanel } from "./deferred-tool-panel";
import { clearPersistedDraft } from "./draft-storage";
import { $insertAddDirTrigger } from "./editor/add-dir/insert";
import { AddDirTriggerNode } from "./editor/add-dir/trigger-node";
import {
	type AddDirPickerEntry,
	AddDirTypeaheadPlugin,
} from "./editor/add-dir/typeahead-plugin";
import { CustomTagBadgeNode } from "./editor/custom-tag-badge-node";
import { FileBadgeNode } from "./editor/file-badge-node";
import { ImageBadgeNode } from "./editor/image-badge-node";
import { AutoResizePlugin } from "./editor/plugins/auto-resize-plugin";
import { CompositionGuardPlugin } from "./editor/plugins/composition-guard-plugin";
import { DraftPersistencePlugin } from "./editor/plugins/draft-persistence-plugin";
import { DropFilePlugin } from "./editor/plugins/drop-file-plugin";
import { EditablePlugin } from "./editor/plugins/editable-plugin";
import { EditorRefPlugin } from "./editor/plugins/editor-ref-plugin";
import { FileMentionPlugin } from "./editor/plugins/file-mention-plugin";
import { HasContentPlugin } from "./editor/plugins/has-content-plugin";
import { PasteImagePlugin } from "./editor/plugins/paste-image-plugin";
import { SlashCommandPlugin } from "./editor/plugins/slash-command-plugin";
import { SubmitPlugin } from "./editor/plugins/submit-plugin";
import { $extractComposerContent } from "./editor/utils";
import { $appendComposerInsertItems } from "./editor-ops";
import type { ElicitationResponseHandler } from "./elicitation";
import { ElicitationPanel } from "./elicitation-panel";
import { FastModeLottieIcon } from "./fast-mode-lottie-icon";
import { GoalReplaceConfirm } from "./goal-replace-confirm";
import { UsageStatsIndicator } from "./usage-stats-indicator";

const OPEN_SETTINGS_EVENT = "helmor:open-settings";

type WorkspaceComposerProps = {
	contextKey: string;
	onSubmit: (
		prompt: string,
		imagePaths: string[],
		filePaths: string[],
		customTags: ComposerCustomTag[],
		options?: {
			permissionModeOverride?: string;
			/** Submit with the opposite follow-up behavior (queue ↔ steer)
			 *  for this single message, leaving the persistent setting alone. */
			oppositeFollowUp?: boolean;
			startSubmitMode?: StartSubmitMode;
			/** Snapshot of the editor's full Lexical state at submit time.
			 *  Captured synchronously before the editor clears so callers
			 *  that need to round-trip chips/text/images (e.g. the kanban
			 *  "backlog" submit handler that copies the draft into a freshly
			 *  created session) can do so without a re-encode pass. */
			editorStateSnapshot?: SerializedEditorState;
		},
	) => void;
	disabled?: boolean;
	submitDisabled?: boolean;
	onStop?: () => void;
	sending?: boolean;
	selectedModelId: string | null;
	modelSections: AgentModelSection[];
	modelsLoading?: boolean;
	onSelectModel: (modelId: string) => void;
	provider?: string;
	effortLevel: string;
	onSelectEffort: (level: string) => void;
	permissionMode: string;
	onChangePermissionMode: (mode: string) => void;
	fastMode?: boolean;
	showFastModePrelude?: boolean;
	onChangeFastMode?: (enabled: boolean) => void;
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
	linkedDirectories?: readonly string[];
	onRemoveLinkedDirectory?: (path: string) => void;
	linkedDirectoriesDisabled?: boolean;
	/** Quick-pick workspace suggestions shown in the /add-dir popup. */
	addDirCandidates?: readonly CandidateDirectory[];
	/** Called when the user selects an entry from the /add-dir popup. */
	onPickAddDir?: (entry: AddDirPickerEntry) => void;
	pendingElicitation?: PendingElicitation | null;
	onElicitationResponse?: ElicitationResponseHandler;
	elicitationResponsePending?: boolean;
	pendingDeferredTool?: PendingDeferredTool | null;
	onDeferredToolResponse?: DeferredToolResponseHandler;
	/** When set, the composer body is replaced with a GoalReplaceConfirm
	 *  panel asking the user whether to overwrite the active codex goal.
	 *  Same in-place takeover pattern as `pendingDeferredTool`. */
	goalReplace?: {
		currentObjective: string;
		newObjective: string;
		onReplace: () => void;
		onCancel: () => void;
	} | null;
	hasPlanReview?: boolean;
	/** When true, the ring is always rendered next to the send button.
	 *  When false (the default), the ring auto-reveals only after usage
	 *  crosses the threshold defined inside the ring component. */
	alwaysShowContextUsage?: boolean;
	/** Helmor session id for the context-usage ring. */
	sessionId?: string | null;
	/** Provider's own session id (Claude Code UUID). Threaded into the
	 *  context-usage ring for its hover-triggered live fetch. */
	providerSessionId?: string | null;
	/** Agent provider for this session — gates the Claude-only rich fetch. */
	agentType?: "claude" | "codex" | null;
	focusShortcut?: string | null;
	togglePlanShortcut?: string | null;
	/** Hotkey that submits the current draft with the opposite follow-up
	 *  behavior (queue ↔ steer) for one message. */
	toggleFollowUpShortcut?: string | null;
	contextPanelOpen?: boolean;
	onToggleContextPanel?: () => void;
	/** Custom placeholder string. When omitted, falls back to the default
	 *  "Ask to make changes…" copy. The kanban view supplies a hint that
	 *  nudges the user toward composing inbox sources for new workspaces. */
	placeholder?: string;
	startSubmitMenu?: boolean;
	startSubmitMode?: StartSubmitMode;
	onStartSubmitModeChange?: (mode: StartSubmitMode) => void;
};

const EMPTY_SLASH_COMMANDS: readonly SlashCommandEntry[] = [];
const EMPTY_LINKED_DIRECTORIES: readonly string[] = [];
const EMPTY_CANDIDATE_DIRECTORIES: readonly CandidateDirectory[] = [];
const noopPickAddDir = (_entry: AddDirPickerEntry) => {};
const noopDeferredToolResponse = (
	_deferred: PendingDeferredTool,
	_behavior: "allow" | "deny",
	_options?: DeferredToolResponseOptions,
) => {};
const noopElicitationResponse: ElicitationResponseHandler = () => {};
type StartSubmitMode = "startNow" | "saveForLater";
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
	modelsLoading = false,
	onSelectModel,
	provider: _provider = "claude",
	effortLevel,
	onSelectEffort,
	permissionMode,
	onChangePermissionMode,
	fastMode = false,
	showFastModePrelude = false,
	onChangeFastMode,
	sendError,
	restoreDraft,
	restoreImages = [],
	restoreFiles = [],
	restoreCustomTags = [],
	restoreNonce = 0,
	pendingInsertRequests = [],
	onPendingInsertRequestsConsumed,
	placeholder,
	slashCommands = EMPTY_SLASH_COMMANDS,
	slashCommandsLoading = false,
	slashCommandsError = false,
	onRetrySlashCommands,
	workspaceRootPath = null,
	linkedDirectories = EMPTY_LINKED_DIRECTORIES,
	onRemoveLinkedDirectory,
	linkedDirectoriesDisabled = false,
	addDirCandidates = EMPTY_CANDIDATE_DIRECTORIES,
	onPickAddDir = noopPickAddDir,
	pendingElicitation = null,
	onElicitationResponse = noopElicitationResponse,
	elicitationResponsePending = false,
	pendingDeferredTool = null,
	onDeferredToolResponse = noopDeferredToolResponse,
	goalReplace = null,
	hasPlanReview = false,
	alwaysShowContextUsage = false,
	sessionId = null,
	providerSessionId = null,
	agentType = null,
	focusShortcut = null,
	togglePlanShortcut = null,
	toggleFollowUpShortcut = null,
	contextPanelOpen = false,
	onToggleContextPanel,
	startSubmitMenu = false,
	startSubmitMode = "startNow",
	onStartSubmitModeChange,
}: WorkspaceComposerProps) {
	const instanceIdRef = useRef(
		`composer-${Math.random().toString(36).slice(2, 10)}`,
	);
	useEffect(() => {
		recordComposerRender(contextKey, instanceIdRef.current);
	});
	const editorRef = useRef<LexicalEditor | null>(null);
	// Root element of the composer surface. Used as the portal anchor for the
	// slash/@ typeahead popups so they hug the top edge of the composer box
	// (with an 8px gap) instead of the caret tracking div Lexical creates on
	// `document.body` — the tracking div follows the caret, which sits *inside*
	// the composer padding and would put the popup's bottom edge underneath the
	// composer rim.
	const composerRootRef = useRef<HTMLDivElement | null>(null);
	const consumedInsertRequestIdsRef = useRef<Set<string>>(new Set());
	const [hasContent, setHasContent] = useState(false);
	const [isInputFocused, setIsInputFocused] = useState(false);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	useEffect(() => {
		const handleFocusComposer = () => {
			if (disabled) return;
			composerRootRef.current
				?.querySelector<HTMLElement>("[contenteditable='true']")
				?.focus();
		};

		window.addEventListener("helmor:focus-composer", handleFocusComposer);
		return () =>
			window.removeEventListener("helmor:focus-composer", handleFocusComposer);
	}, [disabled]);
	const selectedModel = useMemo(() => {
		for (const section of modelSections) {
			for (const option of section.options) {
				if (option.id === selectedModelId) return option;
			}
		}
		return null;
	}, [modelSections, selectedModelId]);
	const hasConfiguredClaudeProviderModels = useMemo(
		() =>
			modelSections.some(
				(section) =>
					section.id === "claude" &&
					section.options.some((option) => Boolean(option.providerKey)),
			),
		[modelSections],
	);
	const availableEffortLevels = useMemo(
		() => selectedModel?.effortLevels ?? [],
		[selectedModel],
	);
	const supportsEffort = availableEffortLevels.length > 0;
	const supportsFastMode = selectedModel?.supportsFastMode === true;
	const supportsContextUsage = selectedModel?.supportsContextUsage !== false;
	const effectiveEffort = useMemo(
		() => clampEffort(effortLevel, availableEffortLevels),
		[effortLevel, availableEffortLevels],
	);
	// When model changes and effort gets clamped, write it back — but only
	// after model metadata has loaded and the model exposes effort levels,
	// otherwise we'd loop on a value the user can't even change.
	useEffect(() => {
		if (!selectedModel) return;
		if (!supportsEffort) return;
		if (effectiveEffort !== effortLevel) {
			onSelectEffort(effectiveEffort);
		}
	}, [
		selectedModel,
		supportsEffort,
		effectiveEffort,
		effortLevel,
		onSelectEffort,
	]);
	const hasPendingElicitation = pendingElicitation !== null;
	const hasPendingDeferredTool = pendingDeferredTool !== null;
	const hasGoalReplace = goalReplace !== null;
	const hasPendingInteraction =
		hasPendingElicitation || hasPendingDeferredTool || hasGoalReplace;
	const inputDisabled = disabled || hasPendingInteraction;
	const toolbarDisabled = disabled || hasPendingInteraction;
	useEffect(() => {
		const handleOpenModelPicker = () => {
			if (toolbarDisabled) return;
			setModelPickerOpen(true);
		};
		window.addEventListener("helmor:open-model-picker", handleOpenModelPicker);
		return () =>
			window.removeEventListener(
				"helmor:open-model-picker",
				handleOpenModelPicker,
			);
	}, [toolbarDisabled]);
	const handleOpenModelSettings = useCallback(() => {
		setModelPickerOpen(false);
		window.dispatchEvent(
			new CustomEvent(OPEN_SETTINGS_EVENT, {
				detail: { section: "model" },
			}),
		);
	}, []);
	const composerToolbarTriggerClassName =
		"cursor-pointer rounded-[9px] px-1 py-0.5 text-[13px] font-medium transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50";
	// Shared gate for Send and Steer — the only difference is whether a
	// stream is currently running. When sending, ⌘Enter / Enter still
	// fires `handleSubmit`; the use-streaming hook dispatches to the
	// steer path based on `sendingContextKeys`.
	const submitEnabled =
		!disabled &&
		!submitDisabled &&
		!hasPendingInteraction &&
		Boolean(selectedModel) &&
		hasContent;
	const sendDisabled = !submitEnabled || sending;
	const steerDisabled = !submitEnabled || !sending;
	const submitDisabledForPlugin = !submitEnabled;
	const showFocusHint =
		!isInputFocused && !hasContent && !inputDisabled && Boolean(focusShortcut);

	// Lexical initial config — must be a new object per mount for key resets
	const initialConfig = useRef({
		namespace: "WorkspaceComposer",
		theme: EDITOR_THEME,
		nodes: [
			ImageBadgeNode,
			FileBadgeNode,
			CustomTagBadgeNode,
			AddDirTriggerNode,
		],
		onError: onEditorError,
	}).current;

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

	const handlePlanImplement = useCallback(() => {
		if (!hasPlanReview) return;
		onChangePermissionMode("bypassPermissions");
		clearPersistedDraft(contextKey);
		onSubmit("Go ahead with the plan.", [], [], [], {
			permissionModeOverride: "bypassPermissions",
		});
	}, [contextKey, hasPlanReview, onChangePermissionMode, onSubmit]);

	const handlePlanRequestChanges = useCallback(() => {
		if (!hasPlanReview) return;
		const editor = editorRef.current;
		let feedback = "";
		if (editor) {
			editor.read(() => {
				feedback = $extractComposerContent().text;
			});
		}
		if (!feedback.trim()) return;
		onSubmit(feedback.trim(), [], [], [], {
			permissionModeOverride: "plan",
		});
		if (editor) {
			editor.update(() => {
				$getRoot().clear();
			});
			clearPersistedDraft(contextKey);
			setHasContent(false);
		}
	}, [hasPlanReview, onSubmit, contextKey]);

	const submitDraft = useCallback(
		(options?: {
			oppositeFollowUp?: boolean;
			startSubmitMode?: StartSubmitMode;
		}) => {
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
			// Snapshot the editor's full Lexical state BEFORE the clear below
			// wipes it. Synchronous capture is critical because callers that
			// want to round-trip the draft (e.g. kanban "backlog" submit
			// copying chips/text/images into a freshly-created session) read
			// from this snapshot — by the time their async work runs, the
			// editor is already empty.
			const editorStateSnapshot = editor
				.getEditorState()
				.toJSON() as SerializedEditorState;
			onSubmit(prompt, images, files, customTags, {
				oppositeFollowUp: options?.oppositeFollowUp,
				startSubmitMode: options?.startSubmitMode,
				editorStateSnapshot,
			});
			editor.update(() => {
				$getRoot().clear();
			});
			clearPersistedDraft(contextKey);
			setHasContent(false);
		},
		[onSubmit, contextKey],
	);

	const handleSubmit = useCallback(() => {
		submitDraft(startSubmitMenu ? { startSubmitMode } : undefined);
	}, [startSubmitMenu, startSubmitMode, submitDraft]);

	const handleSubmitOpposite = useCallback(() => {
		submitDraft({ oppositeFollowUp: true });
	}, [submitDraft]);

	const handleStartSubmitMode = useCallback(
		(mode: StartSubmitMode) => {
			submitDraft({ startSubmitMode: mode });
		},
		[submitDraft],
	);

	const handleSelectStartSubmitMode = useCallback(
		(mode: StartSubmitMode) => {
			onStartSubmitModeChange?.(mode);
			handleStartSubmitMode(mode);
		},
		[handleStartSubmitMode, onStartSubmitModeChange],
	);
	const alternateStartSubmitMode: StartSubmitMode =
		startSubmitMode === "saveForLater" ? "startNow" : "saveForLater";
	const preferredStartSubmitLabel =
		startSubmitMode === "saveForLater" ? "Save for later" : "Start now";
	const alternateStartSubmitLabel =
		alternateStartSubmitMode === "saveForLater"
			? "Save for later"
			: "Start now";

	const handleComposerKeyDownCapture = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (inputDisabled) return;
			const hotkey = normalizeShortcutEvent(event.nativeEvent);
			if (!hotkey) return;

			// Toggle follow-up behavior for one message. Skip when the
			// hotkey is Enter-based — SubmitPlugin handles those via
			// Lexical's KEY_ENTER_COMMAND so we don't double-fire.
			if (
				toggleFollowUpShortcut &&
				hotkey === toggleFollowUpShortcut &&
				event.nativeEvent.key !== "Enter"
			) {
				event.preventDefault();
				event.stopPropagation();
				if (submitEnabled) handleSubmitOpposite();
				return;
			}

			if (togglePlanShortcut && hotkey === togglePlanShortcut) {
				event.preventDefault();
				event.stopPropagation();
				onChangePermissionMode(permissionMode === "plan" ? "default" : "plan");
			}
		},
		[
			inputDisabled,
			onChangePermissionMode,
			permissionMode,
			togglePlanShortcut,
			toggleFollowUpShortcut,
			handleSubmitOpposite,
			submitEnabled,
		],
	);

	return (
		<div
			ref={composerRootRef}
			aria-label="Workspace composer"
			data-focus-scope="composer"
			onKeyDownCapture={handleComposerKeyDownCapture}
			className={cn(
				"relative flex flex-col rounded-2xl border border-border/40 bg-sidebar shadow-[0_-1px_8px_rgba(0,0,0,0.05),0_0_0_1px_rgba(255,255,255,0.02)]",
				// Pending-interaction panels fill the shell edge-to-edge and own
				// their own internal padding; the default composer gets the
				// legacy px-4 pt-3 pb-3 breathing room.
				hasPendingInteraction ? "p-0" : "px-4 pb-3 pt-3",
				inputDisabled &&
					!hasPendingInteraction &&
					"cursor-not-allowed opacity-60",
			)}
		>
			<label htmlFor="workspace-input" className="sr-only">
				Workspace input
			</label>

			{hasPendingElicitation ? (
				<ElicitationPanel
					elicitation={pendingElicitation!}
					disabled={disabled || elicitationResponsePending}
					onResponse={onElicitationResponse}
				/>
			) : hasPendingDeferredTool ? (
				<DeferredToolPanel
					deferred={pendingDeferredTool!}
					disabled={disabled}
					onResponse={onDeferredToolResponse}
				/>
			) : hasGoalReplace ? (
				<GoalReplaceConfirm
					currentObjective={goalReplace.currentObjective}
					newObjective={goalReplace.newObjective}
					onReplace={goalReplace.onReplace}
					onCancel={goalReplace.onCancel}
					disabled={disabled}
				/>
			) : (
				<>
					{onRemoveLinkedDirectory ? (
						<ContextBar
							directories={linkedDirectories.map((path) => {
								const match = addDirCandidates.find(
									(c) => c.absolutePath === path,
								);
								// Display name follows the sidebar's rule
								// (`row-item.tsx`): if the workspace has a branch,
								// show the humanized last segment of the branch
								// (`natllian/refactor-messages` → `Refactor
								// Messages`). Otherwise fall back to the workspace
								// title. For Browse-picked arbitrary paths the
								// match is absent and ContextBar falls back to the
								// basename of `path`.
								const name = match?.branch
									? humanizeBranch(match.branch)
									: match?.title;
								return {
									path,
									name,
									branch: match?.branch ?? null,
									repoIconSrc: match?.repoIconSrc ?? null,
									repoInitials: match?.repoInitials ?? null,
									repoName: match?.repoName ?? null,
								};
							})}
							onRemove={onRemoveLinkedDirectory}
							disabled={linkedDirectoriesDisabled}
						/>
					) : null}
					<LexicalComposer initialConfig={initialConfig}>
						<div
							className="relative"
							onFocusCapture={() => setIsInputFocused(true)}
							onBlurCapture={(event) => {
								if (
									event.currentTarget.contains(
										event.relatedTarget as Node | null,
									)
								) {
									return;
								}
								setIsInputFocused(false);
							}}
						>
							<PlainTextPlugin
								contentEditable={
									<ContentEditable
										id="workspace-input"
										aria-label="Workspace input"
										aria-multiline
										className={cn(
											"composer-editor min-h-[64px] max-h-[240px] resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-foreground outline-none",
											showFocusHint && "pr-28",
										)}
									/>
								}
								placeholder={
									<div className="pointer-events-none absolute left-0 top-0 text-[14px] leading-5 tracking-[-0.01em] text-muted-foreground/70">
										{hasPlanReview && permissionMode === "plan"
											? "Describe what to change, then click Request Changes"
											: (placeholder ??
												"Ask to make changes, @mention files, run /commands")}
									</div>
								}
								ErrorBoundary={LexicalErrorBoundary}
							/>
							{showFocusHint && focusShortcut ? (
								<div className="pointer-events-none absolute right-0 top-0 hidden h-5 items-center gap-1 text-[13px] leading-5 tracking-[-0.01em] text-muted-foreground/70 sm:flex">
									<InlineShortcutDisplay hotkey={focusShortcut} />
									<span>to focus</span>
								</div>
							) : null}
						</div>
						<HistoryPlugin />
						<SlashCommandPlugin
							commands={slashCommands}
							isLoading={slashCommandsLoading}
							isError={slashCommandsError}
							onRetry={onRetrySlashCommands}
							onClientAction={(name, nodeToReplace) => {
								// Built-in /add-dir: swap the typed `/add-dir` text
								// for a purple pill decorator node. Subsequent typing
								// is picked up by AddDirTypeaheadPlugin. Any other
								// client-action name is a no-op here for now.
								if (name === "add-dir" && editorRef.current) {
									$insertAddDirTrigger(editorRef.current, nodeToReplace);
								}
							}}
							popupAnchorRef={composerRootRef}
						/>
						<AddDirTypeaheadPlugin
							candidates={addDirCandidates}
							linkedDirectories={linkedDirectories}
							onPick={onPickAddDir}
							popupAnchorRef={composerRootRef}
						/>
						<FileMentionPlugin
							workspaceRootPath={workspaceRootPath}
							popupAnchorRef={composerRootRef}
						/>
						<SubmitPlugin
							onSubmit={handleSubmit}
							onSubmitOpposite={handleSubmitOpposite}
							toggleHotkey={toggleFollowUpShortcut}
							disabled={submitDisabledForPlugin}
						/>
						<CompositionGuardPlugin />
						<PasteImagePlugin />
						<DropFilePlugin />
						<AutoResizePlugin minHeight={64} maxHeight={240} />
						<EditorRefPlugin editorRef={editorRef} />
						<DraftPersistencePlugin
							contextKey={contextKey}
							restoreDraft={restoreDraft}
							restoreImages={restoreImages}
							restoreFiles={restoreFiles}
							restoreCustomTags={restoreCustomTags}
							restoreNonce={restoreNonce}
						/>
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
							{modelsLoading ? (
								<ShimmerText className="px-1 py-0.5 text-[13px] text-muted-foreground">
									Loading models…
								</ShimmerText>
							) : (
								<>
									<DropdownMenu
										open={modelPickerOpen}
										onOpenChange={setModelPickerOpen}
									>
										<DropdownMenuTrigger
											disabled={toolbarDisabled}
											className={cn(
												`flex items-center gap-1.5 text-muted-foreground ${composerToolbarTriggerClassName}`,
												toolbarDisabled &&
													"cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
											)}
										>
											<ModelIcon
												model={selectedModel}
												className="size-[13px]"
											/>
											<span>
												{selectedModel?.label ??
													selectedModelId ??
													"Select model"}
											</span>
											<ChevronDown
												className="size-3 opacity-40"
												strokeWidth={2}
											/>
										</DropdownMenuTrigger>

										<DropdownMenuContent
											side="top"
											align="start"
											sideOffset={4}
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
															<div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-3">
																<span className="flex size-4 items-center justify-center text-muted-foreground">
																	<ModelIcon
																		model={option}
																		className="size-4"
																	/>
																</span>
																<span className="truncate font-mono tabular-nums">
																	{option.label}
																</span>
															</div>
														</DropdownMenuItem>
													))}
													{section.id === "claude" &&
													!hasConfiguredClaudeProviderModels ? (
														<DropdownMenuItem
															onClick={handleOpenModelSettings}
															className="flex items-center gap-3"
														>
															<span className="flex size-4 items-center justify-center text-muted-foreground">
																<Plus className="size-4" strokeWidth={1.8} />
															</span>
															<span className="font-mono tabular-nums">
																Add custom model...
															</span>
														</DropdownMenuItem>
													) : null}
												</DropdownMenuGroup>
											))}
										</DropdownMenuContent>
									</DropdownMenu>

									{onChangeFastMode && supportsFastMode && (
										<Tooltip>
											<TooltipTrigger asChild>
												<ComposerButton
													aria-label="Fast mode"
													disabled={toolbarDisabled}
													className={cn(
														"relative",
														composerToolbarTriggerClassName,
														fastMode
															? "text-amber-500 hover:bg-amber-500/10 hover:text-amber-500"
															: "text-muted-foreground",
														toolbarDisabled
															? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground"
															: null,
													)}
													onClick={() => onChangeFastMode(!fastMode)}
												>
													<span className="relative block size-[14px]">
														<Zap
															className={cn(
																"absolute inset-0 z-0 size-[14px]",
																fastMode ? null : "opacity-55",
															)}
															strokeWidth={1.8}
														/>
														{showFastModePrelude ? (
															<FastModeLottieIcon className="absolute inset-[-5px] z-10 drop-shadow-[0_0_4px_rgba(245,158,11,0.5)]" />
														) : null}
													</span>
												</ComposerButton>
											</TooltipTrigger>
											<TooltipContent side="top" sideOffset={4}>
												<span>Fast mode{fastMode ? " (on)" : ""}</span>
											</TooltipContent>
										</Tooltip>
									)}

									{supportsEffort && (
										<DropdownMenu>
											<DropdownMenuTrigger
												disabled={toolbarDisabled}
												className={cn(
													`flex items-center gap-0.5 ${composerToolbarTriggerClassName}`,
													effectiveEffort === "max" ||
														effectiveEffort === "xhigh"
														? "effort-max-text"
														: "text-muted-foreground",
													toolbarDisabled
														? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground"
														: null,
												)}
											>
												<span className="capitalize">
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
												sideOffset={4}
												className="min-w-[11rem]"
											>
												<DropdownMenuGroup>
													<DropdownMenuLabel>Effort</DropdownMenuLabel>
													{availableEffortLevels.map((level) => (
														<DropdownMenuItem
															key={level}
															disabled={toolbarDisabled}
															onClick={() => onSelectEffort(level)}
															className="flex items-center justify-between gap-3"
														>
															<div className="flex items-center gap-2.5">
																<EffortBrainIcon level={level} />
																<span className="capitalize">
																	{level === "xhigh" ? "Extra High" : level}
																</span>
															</div>
															{level === effectiveEffort ? (
																<span className="text-[11px] text-foreground">
																	✓
																</span>
															) : null}
														</DropdownMenuItem>
													))}
												</DropdownMenuGroup>
											</DropdownMenuContent>
										</DropdownMenu>
									)}
									<ComposerButton
										aria-label="Plan mode"
										disabled={toolbarDisabled}
										className={cn(
											`gap-1 px-1.5 text-[11px] ${composerToolbarTriggerClassName}`,
											permissionMode === "plan"
												? "text-plan hover:text-plan"
												: "text-muted-foreground/70 hover:text-muted-foreground/70",
										)}
										onClick={() =>
											onChangePermissionMode(
												permissionMode === "plan"
													? "bypassPermissions"
													: "plan",
											)
										}
									>
										<ClipboardList className="size-[13px]" strokeWidth={1.8} />
										<span>Plan</span>
									</ComposerButton>
									{onToggleContextPanel ? (
										<Tooltip>
											<TooltipTrigger asChild>
												<ComposerButton
													aria-label="Add context"
													aria-pressed={contextPanelOpen}
													disabled={toolbarDisabled}
													className={cn(
														composerToolbarTriggerClassName,
														contextPanelOpen
															? "text-foreground"
															: "text-muted-foreground/70 hover:text-muted-foreground/70",
														toolbarDisabled
															? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground"
															: null,
													)}
													onClick={onToggleContextPanel}
												>
													<Layers className="size-[13px]" strokeWidth={1.8} />
												</ComposerButton>
											</TooltipTrigger>
											<TooltipContent side="top" sideOffset={4}>
												<span>Add context</span>
											</TooltipContent>
										</Tooltip>
									) : null}
								</>
							)}
						</div>

						<div className="flex items-center gap-1">
							<UsageStatsIndicator agentType={agentType} disabled={disabled} />
							{sessionId && supportsContextUsage ? (
								<ContextUsageRing
									sessionId={sessionId}
									providerSessionId={providerSessionId}
									composerModelId={selectedModel?.id ?? null}
									cwd={workspaceRootPath}
									agentType={agentType}
									alwaysShow={alwaysShowContextUsage}
									disabled={disabled}
								/>
							) : null}
							{/* Trailing actions sit behind a visible outline/border, while the
							    indicators to the left don't — that pulls the perceived gap in
							    by ~6 px. ml-1.5 reserves the missing space so the row reads as
							    evenly spaced. */}
							{hasPlanReview && permissionMode === "plan" ? (
								<div className="ml-1.5 flex items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										aria-label="Request Changes"
										onClick={handlePlanRequestChanges}
										disabled={disabled || !hasContent}
										className="my-0.5 h-7 cursor-pointer gap-1 rounded-lg px-2 text-[12px] transition-none text-muted-foreground hover:text-foreground"
									>
										<MessageSquareMore className="size-3.5" strokeWidth={1.8} />
										Request Changes
									</Button>
									<Button
										variant="default"
										size="sm"
										aria-label="Implement"
										onClick={handlePlanImplement}
										disabled={disabled}
										className="my-0.5 h-7 cursor-pointer gap-1 rounded-lg px-2 text-[12px] transition-none"
									>
										<Check className="size-3.5" strokeWidth={2} />
										Implement
									</Button>
								</div>
							) : sending ? (
								<div className="ml-1.5 flex items-center gap-1.5">
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
									{hasContent ? (
										<Button
											variant="outline"
											size="icon"
											aria-label="Steer"
											onClick={handleSubmit}
											disabled={steerDisabled}
											className="rounded-[9px]"
										>
											<ArrowUp className="size-[15px]" strokeWidth={2.2} />
										</Button>
									) : null}
								</div>
							) : (
								<div className="ml-1.5 flex items-center">
									{startSubmitMenu ? (
										<DropdownMenu>
											<ButtonGroup className="rounded-[9px]">
												<Button
													variant="outline"
													size="sm"
													aria-label={preferredStartSubmitLabel}
													onClick={() => handleStartSubmitMode(startSubmitMode)}
													disabled={sendDisabled}
													className="gap-1.5 px-2.5"
												>
													{startSubmitMode === "saveForLater" ? (
														<Clock3 className="size-3.5" strokeWidth={1.8} />
													) : (
														<ArrowUp className="size-3.5" strokeWidth={2.2} />
													)}
													<span>{preferredStartSubmitLabel}</span>
												</Button>
												<ButtonGroupSeparator className="bg-border/80" />
												<DropdownMenuTrigger asChild>
													<Button
														variant="outline"
														size="sm"
														aria-label="Start options"
														disabled={sendDisabled}
														className="px-2.5"
													>
														<ChevronDown
															className="size-3 text-muted-foreground"
															strokeWidth={2}
														/>
													</Button>
												</DropdownMenuTrigger>
											</ButtonGroup>
											<DropdownMenuContent
												side="bottom"
												align="end"
												sideOffset={6}
												className="min-w-[133px] -translate-x-px"
											>
												<DropdownMenuItem
													onClick={() =>
														handleSelectStartSubmitMode(
															alternateStartSubmitMode,
														)
													}
													disabled={sendDisabled}
													className="gap-2"
												>
													{alternateStartSubmitMode === "saveForLater" ? (
														<Clock3 className="size-3.5" strokeWidth={1.8} />
													) : (
														<ArrowUp className="size-3.5" strokeWidth={2} />
													)}
													<span>{alternateStartSubmitLabel}</span>
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
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
							)}
						</div>
					</div>
				</>
			)}

			{sendError && hasPendingElicitation ? (
				<div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-muted-foreground">
					{sendError}
				</div>
			) : null}
		</div>
	);
});

function EffortBrainIcon({ level }: { level: string }) {
	const cls = "shrink-0";

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
