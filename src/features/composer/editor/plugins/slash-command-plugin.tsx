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
import { type ReactNode, useCallback, useMemo, useState } from "react";
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

function filterCommands(
	commands: readonly SlashCommandEntry[],
	query: string,
): readonly SlashCommandEntry[] {
	if (!query) return commands;
	const q = query.toLowerCase();
	// Two-pass: prefix matches first (typing "co" surfaces /commit,
	// /context, /compact in that order), then any remaining substring
	// matches.
	const prefix: SlashCommandEntry[] = [];
	const substring: SlashCommandEntry[] = [];
	for (const cmd of commands) {
		const name = cmd.name.toLowerCase();
		if (name.startsWith(q)) {
			prefix.push(cmd);
		} else if (name.includes(q)) {
			substring.push(cmd);
		}
	}
	return [...prefix, ...substring];
}

export function SlashCommandPlugin({
	commands,
	isLoading = false,
	isError = false,
	isRefreshing = false,
	onRetry,
}: {
	commands: readonly SlashCommandEntry[];
	/** True while the slash-command query is in flight (initial fetch or retry). */
	isLoading?: boolean;
	/** True when the query rejected (sidecar timeout, missing CLI, etc). */
	isError?: boolean;
	/** True when local skills are shown but the full list is still loading. */
	isRefreshing?: boolean;
	/** Click handler for the "retry" row in the error state. */
	onRetry?: () => void;
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
			editor.update(() => {
				// Lexical's typeahead plugin splits the text node so that
				// `nodeToReplace` is exactly the `/<query>` slice — replacing
				// its content here doesn't touch any surrounding text. We
				// append a trailing space so the user can immediately type
				// arguments.
				if (nodeToReplace) {
					const replacement = `/${selected.entry.name} `;
					nodeToReplace.setTextContent(replacement);
					nodeToReplace.select(replacement.length, replacement.length);
				}
				closeMenu();
			});
		},
		[editor],
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
				if (!anchorElementRef.current) return null;

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
					// The composer always sits at the bottom of the viewport, so
					// the popup must open *upward* from the caret. Anchored to
					// the typeahead anchor div via `bottom: 100%` so the popup's
					// bottom edge sits just above the cursor with a small gap.
					//
					// `isolate z-[9999]` lifts the popup above every other
					// stacking context on the page. The Lexical anchor div is
					// appended directly to `document.body` but defaults to
					// `z-index: auto`, so without an explicit value plus a
					// fresh stacking context (`isolate`), the popup gets
					// occluded by other body-level overlays (the Tauri title
					// bar, the conversation thread's transform-based
					// stacking contexts, etc.).
					<div className="pointer-events-auto absolute bottom-full left-0 isolate z-[9999] mb-2 w-[min(640px,calc(100vw-2rem))]">
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
								{hasOptions && isRefreshing && (
									<div className="flex items-center gap-2 border-t border-border/40 px-3 py-1.5 text-[12px] text-muted-foreground">
										<Loader2 className="size-3 shrink-0 animate-spin" />
										<span>Loading more commands…</span>
									</div>
								)}
							</CommandList>
						</Command>
					</div>,
					anchorElementRef.current,
				);
			}}
		/>
	);
}
