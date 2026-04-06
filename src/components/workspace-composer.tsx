import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import type { LexicalEditor } from "lexical";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { ArrowUp, ChevronDown, ClipboardList, Square } from "lucide-react";
import {
	type ButtonHTMLAttributes,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { AgentModelSection } from "@/lib/api";
import { recordComposerRender } from "@/lib/dev-render-debug";
import { cn } from "@/lib/utils";
import {
	$createImageBadgeNode,
	ImageBadgeNode,
} from "./composer-editor/image-badge-node";
import { AutoResizePlugin } from "./composer-editor/plugins/auto-resize-plugin";
import { EditablePlugin } from "./composer-editor/plugins/editable-plugin";
import { EditorRefPlugin } from "./composer-editor/plugins/editor-ref-plugin";
import { HasContentPlugin } from "./composer-editor/plugins/has-content-plugin";
import { PasteImagePlugin } from "./composer-editor/plugins/paste-image-plugin";
import { SubmitPlugin } from "./composer-editor/plugins/submit-plugin";
import { $extractComposerContent } from "./composer-editor/utils";
import { ClaudeIcon, OpenAIIcon } from "./icons";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type WorkspaceComposerProps = {
	contextKey: string;
	onSubmit: (prompt: string, imagePaths: string[]) => void;
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
	onTogglePlanMode: () => void;
	sendError?: string | null;
	restoreDraft?: string | null;
	restoreImages?: string[];
	restoreNonce?: number;
};

function ComposerButton({
	children,
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	children: ReactNode;
	className?: string;
}) {
	return (
		<Button
			{...props}
			variant="ghost"
			size="sm"
			className={cn(
				"h-auto gap-1.5 rounded-lg text-app-foreground-soft hover:text-app-foreground",
				className,
			)}
		>
			{children}
		</Button>
	);
}

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

/** Imperatively set Lexical editor content from draft text + image paths. */
function $setEditorContent(draft: string, images: string[]) {
	const root = $getRoot();
	root.clear();
	const paragraph = $createParagraphNode();
	if (draft) {
		paragraph.append($createTextNode(draft));
	}
	for (const path of images) {
		if (draft || paragraph.getChildrenSize() > 0) {
			paragraph.append($createTextNode(" "));
		}
		paragraph.append($createImageBadgeNode(path));
	}
	root.append(paragraph);
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
	onTogglePlanMode,
	sendError,
	restoreDraft,
	restoreImages = [],
	restoreNonce = 0,
}: WorkspaceComposerProps) {
	const instanceIdRef = useRef(
		`composer-${Math.random().toString(36).slice(2, 10)}`,
	);
	recordComposerRender(contextKey, instanceIdRef.current);
	const editorRef = useRef<LexicalEditor | null>(null);
	const [hasContent, setHasContent] = useState(false);
	const isOpus = selectedModelId === "opus-1m" || selectedModelId === "opus";
	const effectiveEffort = (() => {
		let level = effortLevel;
		if (provider === "codex") {
			if (level === "max") level = "xhigh";
		} else {
			if (level === "xhigh") level = isOpus ? "max" : "high";
			if (level === "minimal") level = "low";
			if (level === "max" && !isOpus) level = "high";
		}
		return level;
	})();
	const selectedModel =
		modelSections
			.flatMap((section) => section.options)
			.find((option) => option.id === selectedModelId) ?? null;
	const sendDisabled =
		disabled || submitDisabled || sending || !selectedModel || !hasContent;

	// Lexical initial config — must be a new object per mount for key resets
	const initialConfig = useRef({
		namespace: "WorkspaceComposer",
		theme: EDITOR_THEME,
		nodes: [ImageBadgeNode],
		onError: onEditorError,
	}).current;

	// Restore content on context switch
	const prevContextKeyRef = useRef(contextKey);
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			prevContextKeyRef.current = contextKey;
			editorRef.current?.update(() => {
				$setEditorContent(restoreDraft ?? "", restoreImages);
			});
		}
	}, [contextKey, restoreDraft, restoreImages]);

	// Restore on nonce change (error restore / draft restore)
	const prevNonceRef = useRef(restoreNonce);
	useEffect(() => {
		if (restoreNonce === prevNonceRef.current) return;
		prevNonceRef.current = restoreNonce;
		if (!restoreDraft && restoreImages.length === 0) return;
		editorRef.current?.update(() => {
			$setEditorContent(restoreDraft ?? "", restoreImages);
		});
	}, [restoreNonce, restoreDraft, restoreImages]);

	const handleSubmit = useCallback(() => {
		const editor = editorRef.current;
		if (!editor) return;
		let prompt = "";
		let images: string[] = [];
		editor.read(() => {
			const result = $extractComposerContent();
			prompt = result.text;
			images = result.images;
		});
		if (!prompt && images.length === 0) return;
		onSubmit(prompt, images);
		editor.update(() => {
			$getRoot().clear();
		});
		setHasContent(false);
	}, [onSubmit]);

	return (
		<div
			aria-label="Workspace composer"
			className="flex flex-col rounded-2xl border border-app-border/40 bg-app-sidebar px-4 pb-3 pt-3 shadow-[0_-4px_24px_rgba(0,0,0,0.12),0_0_0_1px_rgba(255,255,255,0.03)]"
		>
			<label htmlFor="workspace-input" className="sr-only">
				Workspace input
			</label>

			<LexicalComposer initialConfig={initialConfig}>
				<div className="relative">
					<PlainTextPlugin
						contentEditable={
							<ContentEditable
								id="workspace-input"
								aria-label="Workspace input"
								aria-multiline
								className="composer-editor min-h-[64px] max-h-[240px] resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-app-foreground outline-none"
							/>
						}
						placeholder={
							<div className="pointer-events-none absolute left-0 top-0 text-[14px] leading-5 tracking-[-0.01em] text-app-muted">
								Ask to make changes, @mention files, run /commands
							</div>
						}
						ErrorBoundary={LexicalErrorBoundary}
					/>
				</div>
				<HistoryPlugin />
				<SubmitPlugin onSubmit={handleSubmit} disabled={sendDisabled} />
				<PasteImagePlugin />
				<AutoResizePlugin minHeight={64} maxHeight={240} />
				<EditorRefPlugin editorRef={editorRef} />
				<EditablePlugin disabled={disabled} />
				<HasContentPlugin onChange={setHasContent} />
			</LexicalComposer>

			{sendError ? (
				<div className="mt-2 rounded-lg border border-app-canceled/30 bg-app-canceled/10 px-3 py-2 text-[12px] text-app-foreground-soft">
					{sendError}
				</div>
			) : null}

			<div className="mt-2.5 flex items-end justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={disabled}
							className={cn(
								"flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft transition-colors hover:text-app-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong",
								disabled &&
									"cursor-not-allowed opacity-45 hover:text-app-foreground-soft",
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
											disabled={disabled}
											onClick={() => {
												onSelectModel(option.id);
											}}
											className="flex items-center justify-between gap-3"
										>
											<div className="flex items-center gap-3">
												<span className="text-app-foreground-soft">
													{option.provider === "codex" ? (
														<OpenAIIcon className="size-4" />
													) : (
														<ClaudeIcon className="size-4" />
													)}
												</span>
												<span className="font-medium">{option.label}</span>
											</div>

											{option.badge ? (
												<span className="rounded-md border border-app-border-strong/70 bg-app-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-app-foreground-soft">
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
							disabled={disabled}
							className={cn(
								"flex items-center gap-0.5 px-1 py-0.5 text-[13px] font-medium focus-visible:outline-none",
								disabled ? "cursor-not-allowed opacity-45" : null,
							)}
						>
							<span
								className={cn(
									"capitalize",
									effectiveEffort === "max" || effectiveEffort === "xhigh"
										? "effort-max-text"
										: "text-violet-400",
								)}
							>
								{effectiveEffort === "xhigh" ? "Extra High" : effectiveEffort}
							</span>
							<ChevronDown
								className="size-3 text-app-foreground-soft/40"
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
										disabled={disabled}
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
											<span className="text-[11px] text-violet-400">✓</span>
										) : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>

					<ComposerButton
						aria-label="Plan mode"
						disabled={disabled}
						className={cn(
							"gap-1.5 rounded-md px-2 py-0.5 text-[13px] font-medium transition-colors",
							permissionMode === "plan"
								? "text-[#48968c] ring-1 ring-[#48968c]/40 hover:text-[#48968c]"
								: "text-app-muted/50 hover:text-app-muted",
						)}
						onClick={onTogglePlanMode}
					>
						<ClipboardList className="size-[14px]" strokeWidth={1.8} />
						<span>Plan</span>
					</ComposerButton>
				</div>

				<div className="flex items-center gap-2">
					{sending ? (
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
