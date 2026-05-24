/**
 * Lexical plugin: `/add-dir` directory picker.
 *
 * Activation model is different from slash and @ mentions: instead of a
 * single trigger character, the picker is active whenever the caret sits
 * in a TextNode whose immediate previous sibling is an `AddDirTriggerNode`
 * (the purple pill). The text typed after the pill becomes the query.
 *
 * Selection of an item (keyboard Enter or click):
 *   - removes the pill + the query text in a single editor update
 *   - invokes `onPick(path)` so the container can mutate the linked-
 *     directories list
 *
 * Backspace at the leading edge of the post-pill text (or immediately
 * after the pill when no text has been typed) deletes the pill in one
 * keystroke — matches the user's "delete in one shot" expectation.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import {
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	KEY_BACKSPACE_COMMAND,
	KEY_ESCAPE_COMMAND,
	type LexicalEditor,
	type TextNode,
} from "lexical";
import { FolderOpen } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import { humanizeBranch } from "@/features/navigation/shared";
import type { CandidateDirectory } from "@/lib/api";
import { cn } from "@/lib/utils";
import { $isAddDirTriggerNode } from "./trigger-node";

/** Minimum leading whitespace we tolerate between the pill and the query. */
const QUERY_LEAD_PATTERN = /^\s*/;

/** One row in the popup. */
export type AddDirPickerEntry =
	| {
			kind: "candidate";
			candidate: CandidateDirectory;
			/** True when the candidate's path is already in the workspace's list. */
			alreadyLinked: boolean;
	  }
	| { kind: "browse" };

class AddDirOption extends MenuOption {
	readonly entry: AddDirPickerEntry;
	constructor(entry: AddDirPickerEntry) {
		super(
			entry.kind === "browse" ? "__browse__" : entry.candidate.absolutePath,
		);
		this.entry = entry;
	}
}

/** Rank a candidate against a query. 0 = filtered out. */
function rankCandidate(c: CandidateDirectory, q: string): number {
	if (!q) return 1;
	const lower = q.toLowerCase();
	// Match what the user actually sees (humanized branch label) plus the
	// raw branch string and repo name for power-user queries.
	const displayName = (
		c.branch ? humanizeBranch(c.branch) : c.title
	).toLowerCase();
	const title = c.title.toLowerCase();
	const repo = c.repoName.toLowerCase();
	const branch = (c.branch ?? "").toLowerCase();
	if (displayName.startsWith(lower) || title.startsWith(lower)) return 4;
	if (repo.startsWith(lower)) return 3;
	if (
		displayName.includes(lower) ||
		title.includes(lower) ||
		repo.includes(lower)
	)
		return 2;
	if (branch.includes(lower)) return 1;
	return 0;
}

export function filterCandidates(
	candidates: readonly CandidateDirectory[],
	query: string,
): CandidateDirectory[] {
	if (!query) return [...candidates];
	const ranked = candidates
		.map((c) => ({ c, score: rankCandidate(c, query) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score);
	return ranked.map((r) => r.c);
}

// ---------------------------------------------------------------------------
// Editor-state helpers
// ---------------------------------------------------------------------------

/**
 * If the caret is in a TextNode whose previous sibling is an
 * `AddDirTriggerNode`, return that node and the sibling. Otherwise null.
 * Must be called inside `editor.getEditorState().read()` (or .update()).
 */
function $findActiveQueryNode(): {
	textNode: TextNode;
	leadingWhitespaceLen: number;
} | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	const anchor = selection.anchor;
	const node = anchor.getNode();
	if (!$isTextNode(node)) return null;
	const prev = node.getPreviousSibling();
	if (!$isAddDirTriggerNode(prev)) return null;
	const text = node.getTextContent();
	const match = QUERY_LEAD_PATTERN.exec(text);
	const leadingWhitespaceLen = match ? match[0].length : 0;
	return { textNode: node, leadingWhitespaceLen };
}

/** Remove pill + trailing text node in one update. */
function $exitAddDirMode(editor: LexicalEditor) {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const node = selection.anchor.getNode();
		if (!$isTextNode(node)) return;
		const prev = node.getPreviousSibling();
		if (!$isAddDirTriggerNode(prev)) return;
		prev.remove();
		node.remove();
	});
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AddDirPickerProps {
	/** Candidate rows, from the backend. */
	candidates: readonly CandidateDirectory[];
	/** Workspace's current linked directories. Used for the "already linked" badge. */
	linkedDirectories: readonly string[];
	/** Selection handler for candidate entries. */
	onPick: (entry: AddDirPickerEntry) => void;
	/**
	 * Popup portal target. Matches how slash/mention popups anchor to the
	 * composer root so the popup sits above the input with an 8px gap.
	 */
	popupAnchorRef?: RefObject<HTMLElement | null>;
}

export function AddDirTypeaheadPlugin({
	candidates,
	linkedDirectories,
	onPick,
	popupAnchorRef,
}: AddDirPickerProps) {
	const [editor] = useLexicalComposerContext();
	const [query, setQuery] = useState<string | null>(null);

	// --- Backspace handling: single-press delete pill when cursor is at the
	// leading edge of the post-pill text (whitespace-only or empty text).
	useEffect(() => {
		return editor.registerCommand<KeyboardEvent>(
			KEY_BACKSPACE_COMMAND,
			(event) => {
				const found = editor
					.getEditorState()
					.read(() => $findActiveQueryNode());
				if (!found) return false;
				const selection = editor.getEditorState().read(() => $getSelection());
				if (!selection || !$isRangeSelection(selection)) return false;
				const offset = selection.anchor.offset;
				// We only collapse the pill when the user is backspacing from
				// the start of the query substring (i.e. offset ≤ leading
				// whitespace). Further into the query, normal character-wise
				// Backspace wins.
				if (offset > found.leadingWhitespaceLen) return false;
				event?.preventDefault();
				$exitAddDirMode(editor);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);

	// --- Escape handling: if the pill is active, swallow Escape and
	// retreat from add-dir mode. Otherwise let Lexical / other plugins
	// keep their default behavior.
	useEffect(() => {
		return editor.registerCommand<KeyboardEvent>(
			KEY_ESCAPE_COMMAND,
			(event) => {
				const found = editor
					.getEditorState()
					.read(() => $findActiveQueryNode());
				if (!found) return false;
				event?.preventDefault();
				$exitAddDirMode(editor);
				return true;
			},
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);

	// --- Trigger: active whenever selection sits after an AddDirTriggerNode.
	// Lexical calls triggerFn from within a read(), so $-functions work.
	const triggerFn = useCallback(
		(text: string) => {
			const found = editor.getEditorState().read(() => $findActiveQueryNode());
			if (!found) return null;
			// `text` is the text of the current text node up to the caret.
			// The pill sits just before it, so `text` already excludes the
			// pill. Drop leading whitespace for the matching string but keep
			// it in `replaceableString` so the replacement swallows the space
			// too (pill is also removed at onSelect time regardless).
			const leadingWsLen = found.leadingWhitespaceLen;
			return {
				leadOffset: 0,
				matchingString: text.slice(leadingWsLen),
				replaceableString: text,
			};
		},
		[editor],
	);

	// --- Options: Browse is always at the top so it's reachable with a
	// single Enter press regardless of how many workspaces the user has
	// or what they've filtered. Candidates follow, labeled `alreadyLinked`
	// where applicable.
	const options = useMemo(() => {
		const linkedSet = new Set(linkedDirectories);
		const filtered = filterCandidates(candidates, query ?? "");
		const rows: AddDirPickerEntry[] = [{ kind: "browse" }];
		for (const c of filtered) {
			rows.push({
				kind: "candidate",
				candidate: c,
				alreadyLinked: linkedSet.has(c.absolutePath),
			});
		}
		return rows.map((entry) => new AddDirOption(entry));
	}, [candidates, linkedDirectories, query]);

	const onSelectOption = useCallback(
		(selected: AddDirOption, _node: TextNode | null, closeMenu: () => void) => {
			// Always remove pill + query in one update regardless of the
			// chosen entry — the picker's job is to leave the editor clean
			// for the next turn. The container still handles DB mutation on
			// its side via onPick.
			$exitAddDirMode(editor);
			closeMenu();
			onPick(selected.entry);
		},
		[editor, onPick],
	);

	return (
		<LexicalTypeaheadMenuPlugin<AddDirOption>
			triggerFn={triggerFn}
			onQueryChange={setQuery}
			onSelectOption={onSelectOption}
			options={options}
			anchorClassName="add-dir-anchor"
			menuRenderFn={(
				anchorElementRef,
				{ selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
			) => {
				const portalTarget =
					popupAnchorRef?.current ?? anchorElementRef.current;
				if (!portalTarget) return null;
				if (options.length === 0) return null;
				const highlightValue = options[selectedIndex ?? 0]?.key ?? "";
				return createPortal(
					<div
						data-typeahead-popup="add-dir"
						className="pointer-events-auto absolute bottom-full left-0 isolate z-[9999] mb-2 w-[min(640px,calc(100vw-2rem))]"
					>
						<Command
							value={highlightValue}
							shouldFilter={false}
							className="rounded-xl border border-border/60 bg-background text-foreground shadow-2xl ring-1 ring-black/5"
						>
							<CommandList className="max-h-72">
								<CommandGroup heading="Add working directory">
									{options.map((opt, index) => (
										<PickerRow
											key={opt.key}
											option={opt}
											isSelected={index === selectedIndex}
											setRef={opt.setRefElement.bind(opt)}
											onSelect={() => selectOptionAndCleanUp(opt)}
											onMouseEnter={() => setHighlightedIndex(index)}
										/>
									))}
								</CommandGroup>
							</CommandList>
							<div className="border-t border-border/40 px-3 py-1.5 font-mono text-mini text-muted-foreground">
								<span>↑↓ navigate · ↵ select · esc cancel</span>
							</div>
						</Command>
					</div>,
					portalTarget,
				);
			}}
		/>
	);
}

function PickerRow({
	option,
	isSelected,
	setRef,
	onSelect,
	onMouseEnter,
}: {
	option: AddDirOption;
	isSelected: boolean;
	setRef: (el: HTMLElement | null) => void;
	onSelect: () => void;
	onMouseEnter: () => void;
}): ReactNode {
	const entry = option.entry;
	const commonCn = cn(
		"min-w-0 gap-2.5 rounded-lg px-2.5 py-2 text-ui",
		isSelected && "bg-muted text-foreground",
	);
	if (entry.kind === "browse") {
		return (
			<CommandItem
				value={option.key}
				ref={setRef}
				onSelect={onSelect}
				onMouseEnter={onMouseEnter}
				onPointerDown={(event) => event.preventDefault()}
				className={commonCn}
			>
				<FolderOpen
					className="size-4 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				{/* "Browse folder…" takes the flex-1 slot so the description
				    gets pushed to the right edge of the row, matching the
				    position of `branch` in candidate rows below. */}
				<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
					Browse folder…
				</span>
				<span className="shrink-0 whitespace-nowrap text-small text-muted-foreground">
					pick any directory on disk
				</span>
			</CommandItem>
		);
	}
	const c = entry.candidate;
	return (
		<CommandItem
			value={option.key}
			ref={setRef}
			onSelect={onSelect}
			onMouseEnter={onMouseEnter}
			onPointerDown={(event) => event.preventDefault()}
			className={commonCn}
		>
			<WorkspaceAvatar
				repoIconSrc={c.repoIconSrc}
				repoInitials={c.repoInitials}
				repoName={c.repoName}
				title={c.title}
			/>
			{/* Display name follows the sidebar rule: humanize the branch's
			    last segment when present, otherwise fall back to the
			    workspace title. `title` attribute exposes the full path on
			    hover for power users. `flex-1` lets the name absorb extra
			    width so the branch on the right stays fully visible. */}
			<span
				className="min-w-0 flex-1 truncate font-medium"
				title={c.absolutePath}
			>
				{c.branch ? humanizeBranch(c.branch) : c.title}
			</span>
			{c.branch ? (
				<span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-micro text-[var(--workspace-sidebar-branch)]">
					<BranchIcon /> {c.branch}
				</span>
			) : null}
			{entry.alreadyLinked ? (
				<span className="ml-1 shrink-0 font-mono text-micro text-muted-foreground">
					linked
				</span>
			) : null}
		</CommandItem>
	);
}

function BranchIcon(): ReactNode {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			aria-hidden
		>
			<circle cx="4" cy="3.5" r="1.4" />
			<circle cx="4" cy="12.5" r="1.4" />
			<circle cx="12" cy="6" r="1.4" />
			<path d="M4 5v6M4 8c0-2 1.5-3 4-3h2" />
		</svg>
	);
}
