/**
 * Lexical plugin: @-mention file picker.
 *
 * Mirrors `slash-command-plugin.tsx` but for files. Trigger character is `@`,
 * the data source is `listWorkspaceFiles` (cached per workspace root), and
 * selection inserts a `FileBadgeNode` in place of the `@<query>` text rather
 * than replacing the text with a command name. The badge is the same node
 * the drag-drop plugin produces, so `$extractComposerContent()` already knows
 * how to serialize it as `@relative/path.ts` for the agent prompt.
 *
 * The popup is anchored, navigated, and positioned by Lexical's
 * `LexicalTypeaheadMenuPlugin` — same primitive used by the slash plugin.
 * We only render the visual surface and own the filter/insertion logic.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
	useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useQuery } from "@tanstack/react-query";
import { $createTextNode, type TextNode } from "lexical";
import { FileText } from "lucide-react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import type { InspectorFileItem } from "@/lib/editor-session";
import { workspaceFilesQueryOptions } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { $createFileBadgeNode } from "../file-badge-node";

/** Cap the visible option list. With ~5000 files in cache, rendering them all
 * into cmdk would tank typing latency for no UX benefit — users always narrow
 * with a query before scrolling. */
export const MAX_VISIBLE_OPTIONS = 50;

class FileMentionOption extends MenuOption {
	readonly file: InspectorFileItem;
	constructor(file: InspectorFileItem) {
		// MenuOption keys must be unique within the visible list. Path is
		// guaranteed unique within a workspace; name alone is not (multiple
		// `index.ts` files are common).
		super(file.path);
		this.file = file;
	}
}

/**
 * Rank files against a query. Higher score = better match.
 * - 3: filename starts with query
 * - 2: filename contains query
 * - 1: full path contains query
 * - 0: no match (filtered out)
 *
 * Within the same score bucket we preserve the upstream sort (priority by
 * src/ → app/lib/components/ → root → nested), which gives a sensible empty-
 * query default ordering.
 */
export function rankFile(file: InspectorFileItem, query: string): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const name = file.name.toLowerCase();
	const path = file.path.toLowerCase();
	if (name.startsWith(q)) return 3;
	if (name.includes(q)) return 2;
	if (path.includes(q)) return 1;
	return 0;
}

export function filterFiles(
	files: readonly InspectorFileItem[],
	query: string,
): InspectorFileItem[] {
	if (!query) return files.slice(0, MAX_VISIBLE_OPTIONS);
	// Stable sort by descending rank — Array.sort is stable in modern engines,
	// so equal-rank items keep their backend ordering.
	const ranked = files
		.map((file) => ({ file, score: rankFile(file, query) }))
		.filter((entry) => entry.score > 0);
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, MAX_VISIBLE_OPTIONS).map((entry) => entry.file);
}

export function FileMentionPlugin({
	workspaceRootPath,
	popupAnchorRef,
}: {
	workspaceRootPath: string | null;
	/**
	 * Optional portal target for the popup. When provided, the popup is rendered
	 * inside this element (expected to be `position: relative`) so `bottom-full`
	 * anchors the popup to the container's top edge rather than the caret. Falls
	 * back to Lexical's caret-tracking anchor div when omitted.
	 */
	popupAnchorRef?: RefObject<HTMLElement | null>;
}) {
	const [editor] = useLexicalComposerContext();
	const [query, setQuery] = useState<string | null>(null);

	// Defer the recursive workspace walk to an idle frame so it doesn't
	// compete with the view-switch reconciliation. By the time the user
	// types `@`, the cache is usually warm.
	const [hasIdledOnce, setHasIdledOnce] = useState(false);
	useEffect(() => {
		if (!workspaceRootPath || hasIdledOnce) return;
		const win = typeof window === "undefined" ? null : window;
		const ric =
			win && "requestIdleCallback" in win
				? win.requestIdleCallback.bind(win)
				: null;
		const cic =
			win && "cancelIdleCallback" in win
				? win.cancelIdleCallback.bind(win)
				: null;
		if (ric) {
			const handle = ric(() => setHasIdledOnce(true), { timeout: 1500 });
			return () => cic?.(handle);
		}
		const timer = setTimeout(() => setHasIdledOnce(true), 800);
		return () => clearTimeout(timer);
	}, [workspaceRootPath, hasIdledOnce]);

	// Light up immediately if the picker opens before idle.
	const pickerActive = query !== null;
	const filesQuery = useQuery({
		...workspaceFilesQueryOptions(workspaceRootPath ?? ""),
		enabled: Boolean(workspaceRootPath) && (hasIdledOnce || pickerActive),
	});

	const files = filesQuery.data ?? [];

	const options = useMemo(() => {
		const filtered = filterFiles(files, query ?? "");
		return filtered.map((file) => new FileMentionOption(file));
	}, [files, query]);

	const triggerFn = useBasicTypeaheadTriggerMatch("@", {
		minLength: 0,
		// Lexical's helper enforces a word boundary before `@` by default —
		// `email@domain` won't trigger, only `@` at start of input or after
		// whitespace/punctuation does. That matches what we want.
	});

	const onSelectOption = useCallback(
		(
			selected: FileMentionOption,
			nodeToReplace: TextNode | null,
			closeMenu: () => void,
		) => {
			editor.update(() => {
				if (nodeToReplace) {
					// Swap the `@<query>` text slice for an inline file badge,
					// then drop a trailing space TextNode so the caret has a
					// landing spot to continue typing.
					const badge = $createFileBadgeNode(selected.file.path);
					const trailing = $createTextNode(" ");
					nodeToReplace.replace(badge);
					badge.insertAfter(trailing);
					trailing.select(1, 1);
				}
				closeMenu();
			});
		},
		[editor],
	);

	return (
		<LexicalTypeaheadMenuPlugin<FileMentionOption>
			triggerFn={triggerFn}
			onQueryChange={setQuery}
			onSelectOption={onSelectOption}
			options={options}
			anchorClassName="file-mention-anchor"
			menuRenderFn={(
				anchorElementRef,
				{ selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
			) => {
				// Prefer the composer root (passed in via prop) so the popup hugs
				// the input's top edge with an 8px gap. Fall back to Lexical's
				// caret-tracking anchor when no explicit container is provided.
				const portalTarget =
					popupAnchorRef?.current ?? anchorElementRef.current;
				if (!portalTarget) return null;
				if (options.length === 0) return null;

				const highlightValue = options[selectedIndex ?? 0]?.file.path ?? "";

				return createPortal(
					// Same anchor strategy as the slash command popup: `bottom-full`
					// + `mb-2` relative to the composer root puts the popup 8px
					// above the input's top edge with a high-z isolated stacking
					// context so it sits above the Tauri title bar / scroll
					// transforms in the conversation pane.
					<div
						data-typeahead-popup="mention"
						className="pointer-events-auto absolute bottom-full left-0 isolate z-[9999] mb-2 w-[min(640px,calc(100vw-2rem))]"
					>
						<Command
							value={highlightValue}
							shouldFilter={false}
							className="rounded-xl border border-border/60 bg-background text-foreground shadow-2xl ring-1 ring-black/5"
						>
							<CommandList className="max-h-72">
								<CommandEmpty>No files</CommandEmpty>
								<CommandGroup heading="Files">
									{options.map((opt, index) => {
										const file = opt.file;
										const isSelected = index === selectedIndex;
										// Show the directory portion of the path dimmed,
										// filename in foreground. For root files the
										// directory portion is empty.
										const lastSlash = file.path.lastIndexOf("/");
										const directory =
											lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : "";
										return (
											<CommandItem
												key={opt.key}
												value={file.path}
												ref={(el) => opt.setRefElement(el)}
												onSelect={() => selectOptionAndCleanUp(opt)}
												onMouseEnter={() => setHighlightedIndex(index)}
												onPointerDown={(event) => event.preventDefault()}
												className={cn(
													"min-w-0 rounded-lg px-2.5 py-2 text-[13px]",
													isSelected && "bg-muted text-foreground",
												)}
											>
												<FileText
													className="size-3.5 shrink-0 text-muted-foreground"
													strokeWidth={1.8}
												/>
												<span className="min-w-0 shrink-0 truncate font-medium">
													{file.name}
												</span>
												<span
													className="min-w-0 flex-1 truncate whitespace-nowrap text-xs text-muted-foreground"
													title={file.path}
												>
													{directory}
												</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
							</CommandList>
						</Command>
					</div>,
					portalTarget,
				);
			}}
		/>
	);
}
