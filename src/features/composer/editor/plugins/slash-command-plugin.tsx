/**
 * Lexical plugin: slash-command autocomplete popup.
 *
 * Built on top of `@lexical/react/LexicalTypeaheadMenuPlugin`, the official
 * Meta-maintained typeahead infrastructure. Lexical owns:
 *
 *   - trigger detection (`useBasicTypeaheadTriggerMatch("/")`)
 *   - keyboard navigation (↑/↓/Enter/Tab/Esc)
 *   - scroll-into-view as the highlight moves (it dispatches
 *     `SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND` and reads the per-option
 *     ref we wire up via `MenuOption.setRefElement`)
 *   - anchor positioning (a tracking div that follows the caret across
 *     scrolls and viewport resizes — same primitive Lexical's mention
 *     plugins use)
 *   - replacing the matched `/<query>` slice with the chosen command via
 *     `selectOptionAndCleanUp`
 *
 * We only render the visual surface — cmdk's `Command` primitive is
 * disabled as a filter (we hand it the already-filtered list and drive
 * its `value` from Lexical's `selectedIndex`).
 *
 * The list is provided by the parent (fetched once per workspace via
 * React Query). We dedupe by name as a defense-in-depth — the SDK can
 * occasionally return the same skill twice when it's registered through
 * multiple sources.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
	useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import type { TextNode } from "lexical";
import { Loader2, RefreshCw } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import type { SlashCommandEntry } from "@/lib/api";
import { cn } from "@/lib/utils";

class SlashCommandOption extends MenuOption {
	readonly entry: SlashCommandEntry;
	constructor(entry: SlashCommandEntry) {
		super(entry.name);
		this.entry = entry;
	}
}

function dedupeByName(
	commands: readonly SlashCommandEntry[],
): readonly SlashCommandEntry[] {
	const seen = new Set<string>();
	const out: SlashCommandEntry[] = [];
	for (const cmd of commands) {
		if (seen.has(cmd.name)) continue;
		seen.add(cmd.name);
		out.push(cmd);
	}
	return out;
}

function compactCommandSearchText(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isOrderedSubsequence(query: string, value: string): boolean {
	let queryIndex = 0;
	for (const char of value) {
		if (char === query[queryIndex]) {
			queryIndex += 1;
			if (queryIndex === query.length) return true;
		}
	}
	return false;
}

/**
 * Rank slash commands against a query. Higher score = better match.
 * - 5: literal command name starts with query
 * - 4: literal command name contains query
 * - 3: separator-normalized command name starts with query
 * - 2: separator-normalized command name contains query
 * - 1: ordered fuzzy match on separator-normalized name
 * - 0: no match
 */
export function rankCommand(command: SlashCommandEntry, query: string): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const name = command.name.toLowerCase();
	if (name.startsWith(q)) return 5;
	if (name.includes(q)) return 4;

	const compactQuery = compactCommandSearchText(q);
	const compactName = compactCommandSearchText(name);
	if (!compactQuery) return 1;
	if (compactName.startsWith(compactQuery)) return 3;
	if (compactName.includes(compactQuery)) return 2;
	if (isOrderedSubsequence(compactQuery, compactName)) return 1;
	return 0;
}

export function filterCommands(
	commands: readonly SlashCommandEntry[],
	query: string,
): readonly SlashCommandEntry[] {
	if (!query) return commands;
	const ranked = commands
		.map((command) => ({ command, score: rankCommand(command, query) }))
		.filter((entry) => entry.score > 0);
	ranked.sort((a, b) => b.score - a.score);
	return ranked.map((entry) => entry.command);
}

export function SlashCommandPlugin({
	commands,
	isLoading = false,
	isError = false,
	onRetry,
	onClientAction,
	popupAnchorRef,
}: {
	commands: readonly SlashCommandEntry[];
	/** True while the slash-command query is in flight (initial fetch or retry). */
	isLoading?: boolean;
	/** True when the query rejected (sidecar timeout, missing CLI, etc). */
	isError?: boolean;
	/** Click handler for the "retry" row in the error state. */
	onRetry?: () => void;
	/**
	 * Fired when the user selects a `source: "client-action"` entry. The
	 * plugin closes the menu but leaves the TextNode that held the typed
	 * `/<query>` slice in place — the caller receives that node and can
	 * replace it with a custom Lexical node (e.g. an inline pill) inside
	 * a single editor update. `nodeToReplace` may be null when Lexical
	 * couldn't resolve the slice (rare; we guard in the callback).
	 */
	onClientAction?: (name: string, nodeToReplace: TextNode | null) => void;
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

	// Dedupe once per `commands` prop change. Defense-in-depth: the
	// sidecar already dedupes on the Claude side, but if a stale React
	// Query cache or a future provider returns dupes the popup still
	// shows them as one row.
	const deduped = useMemo(() => dedupeByName(commands), [commands]);

	const options = useMemo(() => {
		const filtered = filterCommands(deduped, query ?? "");
		return filtered.map((cmd) => new SlashCommandOption(cmd));
	}, [deduped, query]);

	const triggerFn = useBasicTypeaheadTriggerMatch("/", {
		minLength: 0,
		// `/` should fire only at a word boundary; Lexical's helper handles
		// this by default (it won't match if preceded by a word char).
	});

	const onSelectOption = useCallback(
		(
			selected: SlashCommandOption,
			nodeToReplace: TextNode | null,
			closeMenu: () => void,
		) => {
			const isClientAction = selected.entry.source === "client-action";
			if (isClientAction) {
				// Don't mutate the editor here — the client-action handler
				// owns the replacement (e.g. swapping the slice for a
				// decorator pill). Just close the typeahead menu.
				closeMenu();
				onClientAction?.(selected.entry.name, nodeToReplace);
				return;
			}
			editor.update(() => {
				if (nodeToReplace) {
					// Lexical's typeahead plugin splits the text node so that
					// `nodeToReplace` is exactly the `/<query>` slice. For
					// regular commands we replace the slice with `/<name> ` so
					// the user can keep typing arguments.
					const replacement = `/${selected.entry.name} `;
					nodeToReplace.setTextContent(replacement);
					nodeToReplace.select(replacement.length, replacement.length);
				}
				closeMenu();
			});
		},
		[editor, onClientAction],
	);

	return (
		<LexicalTypeaheadMenuPlugin<SlashCommandOption>
			triggerFn={triggerFn}
			onQueryChange={setQuery}
			onSelectOption={onSelectOption}
			options={options}
			anchorClassName="slash-command-anchor"
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

				// Resolve the popup state. We always render *something* now —
				// returning null when `options.length === 0` used to make the
				// popup silently invisible during a slow/failed slash-commands
				// fetch, which looked like "/ doesn't work" to the user.
				const hasOptions = options.length > 0;
				const queryActive = (query ?? "").length > 0;

				let stateRow: ReactNode = null;
				if (!hasOptions) {
					if (isLoading) {
						stateRow = (
							<div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
								<Loader2 className="size-3.5 shrink-0 animate-spin" />
								<span>Loading commands…</span>
							</div>
						);
					} else if (isError) {
						stateRow = (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => onRetry?.()}
								className="h-auto w-full justify-start gap-2 px-3 py-2 text-left text-[13px] text-muted-foreground hover:text-foreground"
							>
								<RefreshCw
									data-icon="inline-start"
									className="size-3.5 shrink-0"
								/>
								<span>Failed to load commands · click to retry</span>
							</Button>
						);
					} else if (queryActive) {
						stateRow = (
							<div className="px-3 py-2 text-[13px] text-muted-foreground">
								No matches
							</div>
						);
					} else {
						stateRow = (
							<div className="px-3 py-2 text-[13px] text-muted-foreground">
								No commands available
							</div>
						);
					}
				}

				const highlightValue = options[selectedIndex ?? 0]?.entry.name ?? "";

				return createPortal(
					// The popup hugs the composer's top edge: `bottom-full` puts
					// the popup's bottom on the composer's top edge and `mb-2`
					// adds an 8px gap. This only works because `popupAnchorRef`
					// points at the `position: relative` composer root — Lexical's
					// default caret-tracking anchor would put the popup's bottom
					// at the caret, not the composer rim, which is what caused
					// the popup to render underneath the input box.
					//
					// `isolate z-[9999]` lifts the popup above every other
					// stacking context on the page so overlays like the Tauri
					// title bar and transform-based stacking contexts in the
					// conversation thread don't occlude it.
					<div
						data-typeahead-popup="slash"
						className="pointer-events-auto absolute bottom-full left-0 isolate z-[9999] mb-2 w-[min(640px,calc(100vw-2rem))]"
					>
						<Command
							value={highlightValue}
							shouldFilter={false}
							className="rounded-xl border border-border/60 bg-background text-foreground shadow-2xl ring-1 ring-black/5"
						>
							<CommandList className="max-h-72">
								{stateRow}
								{hasOptions ? (
									<CommandGroup heading="Commands">
										{options.map((opt, index) => {
											const cmd = opt.entry;
											const isSelected = index === selectedIndex;
											return (
												<CommandItem
													key={opt.key}
													value={cmd.name}
													// Lexical's scroll-into-view dispatcher reads
													// the DOM node from this ref to keep the active
													// row in view as the user navigates.
													ref={(el) => opt.setRefElement(el)}
													onSelect={() => selectOptionAndCleanUp(opt)}
													onMouseEnter={() => setHighlightedIndex(index)}
													// Don't steal focus from the editor on click —
													// we want the caret to stay so users can keep
													// typing.
													onPointerDown={(event) => event.preventDefault()}
													className={cn(
														"min-w-0 rounded-lg px-2.5 py-2 text-[13px]",
														isSelected && "bg-muted text-foreground",
													)}
												>
													<span className="shrink-0 text-muted-foreground">
														/
													</span>
													<span className="min-w-0 shrink-0 truncate font-medium">
														{cmd.name}
													</span>
													<span
														className="min-w-0 flex-1 truncate whitespace-nowrap text-xs text-muted-foreground"
														title={cmd.description}
													>
														{cmd.description}
													</span>
												</CommandItem>
											);
										})}
									</CommandGroup>
								) : null}
							</CommandList>
						</Command>
					</div>,
					portalTarget,
				);
			}}
		/>
	);
}
