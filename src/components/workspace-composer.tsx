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
import { ClaudeIcon, OpenAIIcon } from "./icons";
import { isImagePath } from "./image-preview";
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
// ContentEditable helpers
// ---------------------------------------------------------------------------

const IMAGE_BADGE_ATTR = "data-image-path";

/** Create an inline image badge DOM element for insertion into the editor. */
function createImageBadgeElement(path: string): HTMLSpanElement {
	const badge = document.createElement("span");
	badge.setAttribute(IMAGE_BADGE_ATTR, path);
	badge.contentEditable = "false";
	badge.className =
		"inline-flex items-center gap-1 rounded border border-app-border/60 text-[12px] mx-0.5 align-middle cursor-default select-none transition-colors hover:border-app-foreground-soft/40 hover:bg-app-foreground/[0.03]";

	const icon = document.createElement("span");
	icon.className = "inline-flex items-center gap-1.5 px-1.5 py-0.5";
	icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-3 shrink-0 text-app-project"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
	const nameSpan = document.createElement("span");
	nameSpan.className = "max-w-[200px] truncate text-app-foreground-soft";
	nameSpan.textContent = path.split("/").pop() ?? path;
	icon.appendChild(nameSpan);

	const removeBtn = document.createElement("span");
	removeBtn.className =
		"px-1 py-0.5 text-app-muted/40 hover:text-app-muted cursor-pointer";
	removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-3"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
	removeBtn.setAttribute("data-remove-image", "true");

	badge.appendChild(icon);
	badge.appendChild(removeBtn);
	return badge;
}

/** Extract text and image paths from the contentEditable element. */
function extractEditorContent(el: HTMLElement): {
	text: string;
	images: string[];
} {
	const images: string[] = [];
	const textParts: string[] = [];

	function walk(node: Node) {
		if (node.nodeType === Node.TEXT_NODE) {
			textParts.push(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const element = node as HTMLElement;

		// Image badge — collect path, represent as @path in text
		const imgPath = element.getAttribute(IMAGE_BADGE_ATTR);
		if (imgPath) {
			images.push(imgPath);
			textParts.push(`@${imgPath}`);
			return;
		}

		// Line breaks
		const tag = element.tagName;
		if (tag === "BR") {
			textParts.push("\n");
			return;
		}
		if (tag === "DIV" || tag === "P") {
			// Block elements add a newline before if there's preceding content
			if (textParts.length > 0 && textParts[textParts.length - 1] !== "\n") {
				textParts.push("\n");
			}
		}

		for (const child of node.childNodes) {
			walk(child);
		}
	}

	for (const child of el.childNodes) {
		walk(child);
	}

	return {
		text: textParts
			.join("")
			// Remove zero-width spaces used as cursor spacers
			.replace(/\u200B/g, " ")
			.replace(/ {2,}/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		images: [...new Set(images)],
	};
}

/** Check if the editor is effectively empty (no text, no images). */
function isEditorEmpty(el: HTMLElement): boolean {
	const { text, images } = extractEditorContent(el);
	return text.replace(/@\/\S+/g, "").trim().length === 0 && images.length === 0;
}

/** Set editor content from text draft + image paths for restore. */
function setEditorContent(el: HTMLElement, draft: string, images: string[]) {
	el.innerHTML = "";
	if (draft) {
		el.appendChild(document.createTextNode(draft));
	}
	for (const path of images) {
		if (draft) {
			el.appendChild(document.createTextNode(" "));
		}
		el.appendChild(createImageBadgeElement(path));
	}
}

/** Place cursor at the end of the contentEditable element. */
function placeCursorAtEnd(el: HTMLElement) {
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Insert an image badge at the current cursor position. */
function insertImageBadgeAtCursor(editor: HTMLElement, path: string) {
	const badge = createImageBadgeElement(path);
	const selection = window.getSelection();

	if (!selection || selection.rangeCount === 0) {
		// No selection — append at end
		editor.appendChild(badge);
		editor.appendChild(document.createTextNode("\u200B"));
		placeCursorAtEnd(editor);
		return;
	}

	const range = selection.getRangeAt(0);

	// Ensure cursor is within the editor
	if (!editor.contains(range.commonAncestorContainer)) {
		editor.appendChild(badge);
		editor.appendChild(document.createTextNode("\u200B"));
		placeCursorAtEnd(editor);
		return;
	}

	range.deleteContents();
	// Insert a zero-width space after the badge so the cursor has a place to land
	const spacer = document.createTextNode("\u200B");
	range.insertNode(spacer);
	range.insertNode(badge);

	// Move cursor after the spacer
	const newRange = document.createRange();
	newRange.setStartAfter(spacer);
	newRange.collapse(true);
	selection.removeAllRanges();
	selection.addRange(newRange);
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
	const editorRef = useRef<HTMLDivElement>(null);
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

	const updateHasContent = useCallback(() => {
		const el = editorRef.current;
		if (!el) return;
		setHasContent(!isEditorEmpty(el));
	}, []);

	// Restore content on context switch
	const prevContextKeyRef = useRef(contextKey);
	useEffect(() => {
		if (prevContextKeyRef.current !== contextKey) {
			prevContextKeyRef.current = contextKey;
			const el = editorRef.current;
			if (el) {
				setEditorContent(el, restoreDraft ?? "", restoreImages);
				updateHasContent();
			}
		}
	}, [contextKey, restoreDraft, restoreImages, updateHasContent]);

	// Restore on nonce change (error restore / draft restore)
	const prevNonceRef = useRef(restoreNonce);
	useEffect(() => {
		if (restoreNonce === prevNonceRef.current) return;
		prevNonceRef.current = restoreNonce;
		if (!restoreDraft && restoreImages.length === 0) return;
		const el = editorRef.current;
		if (el) {
			setEditorContent(el, restoreDraft ?? "", restoreImages);
			updateHasContent();
		}
	}, [restoreNonce, restoreDraft, restoreImages, updateHasContent]);

	// Auto-resize editor, capped at max height
	const EDITOR_MAX_HEIGHT = 240;
	useEffect(() => {
		const el = editorRef.current;
		if (!el) return;
		el.style.height = "auto";
		const next = Math.min(el.scrollHeight, EDITOR_MAX_HEIGHT);
		el.style.height = `${next}px`;
		el.scrollTop = el.scrollHeight;
	});

	const handleSubmit = useCallback(() => {
		const el = editorRef.current;
		if (!el) return;
		const { text, images } = extractEditorContent(el);
		// text already contains @path references, so just use it as the prompt
		const prompt = text.trim();
		if (!prompt && images.length === 0) return;
		onSubmit(prompt, images);
		el.innerHTML = "";
		setHasContent(false);
	}, [onSubmit]);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent<HTMLDivElement>) => {
			const el = editorRef.current;
			if (!el) return;

			const pastedText = event.clipboardData.getData("text/plain");
			if (!pastedText) return;

			// Check if any of the pasted lines contain image paths
			const lines = pastedText.split("\n");
			const hasImagePaths = lines.some((line) => isImagePath(line.trim()));

			if (!hasImagePaths) {
				// No image paths — let the browser handle as plain text paste
				event.preventDefault();
				// Insert as plain text (avoid HTML paste)
				const selection = window.getSelection();
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					range.deleteContents();
					range.insertNode(document.createTextNode(pastedText));
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				updateHasContent();
				return;
			}

			// Has image paths — prevent default, insert mixed content
			event.preventDefault();

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) {
					if (i < lines.length - 1) {
						// Insert line break for empty lines between content
						const selection = window.getSelection();
						if (selection && selection.rangeCount > 0) {
							const range = selection.getRangeAt(0);
							range.deleteContents();
							range.insertNode(document.createElement("br"));
							range.collapse(false);
						}
					}
					continue;
				}
				if (isImagePath(line)) {
					insertImageBadgeAtCursor(el, line);
				} else {
					// Insert as text
					const selection = window.getSelection();
					if (selection && selection.rangeCount > 0) {
						const range = selection.getRangeAt(0);
						range.deleteContents();
						range.insertNode(document.createTextNode(line));
						range.collapse(false);
					}
				}
				// Add line break between lines (but not after the last one)
				if (i < lines.length - 1) {
					const selection = window.getSelection();
					if (selection && selection.rangeCount > 0) {
						const range = selection.getRangeAt(0);
						range.insertNode(document.createElement("br"));
						range.collapse(false);
					}
				}
			}

			updateHasContent();
		},
		[updateHasContent],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (!sendDisabled) {
					handleSubmit();
				}
			}
		},
		[sendDisabled, handleSubmit],
	);

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			// Handle remove button clicks on image badges
			const target = event.target as HTMLElement;
			const removeBtn = target.closest("[data-remove-image]");
			if (removeBtn) {
				event.preventDefault();
				event.stopPropagation();
				const badge = removeBtn.closest(`[${IMAGE_BADGE_ATTR}]`);
				if (badge) {
					badge.remove();
					updateHasContent();
				}
				return;
			}
		},
		[updateHasContent],
	);

	return (
		<div
			aria-label="Workspace composer"
			className="flex flex-col rounded-2xl border border-app-border/40 bg-app-sidebar px-4 pb-3 pt-3 shadow-[0_-4px_24px_rgba(0,0,0,0.12),0_0_0_1px_rgba(255,255,255,0.03)]"
		>
			<label htmlFor="workspace-input" className="sr-only">
				Workspace input
			</label>

			<div
				ref={editorRef}
				id="workspace-input"
				role="textbox"
				aria-label="Workspace input"
				aria-multiline="true"
				contentEditable={!disabled}
				suppressContentEditableWarning
				onInput={updateHasContent}
				onPaste={handlePaste}
				onKeyDown={handleKeyDown}
				onClick={handleClick}
				data-placeholder="Ask to make changes, @mention files, run /commands"
				className={cn(
					"composer-editor min-h-[64px] max-h-[240px] resize-none overflow-y-auto bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-app-foreground outline-none",
					"empty:before:pointer-events-none empty:before:text-app-muted empty:before:content-[attr(data-placeholder)]",
				)}
			/>

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
