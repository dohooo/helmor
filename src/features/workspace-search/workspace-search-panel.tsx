import { useQuery } from "@tanstack/react-query";
import { CaseSensitive, FileSearch, Loader2, Regex, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import {
	searchWorkspace,
	type WorkspaceSearchMatch,
	type WorkspaceSearchResult,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/// How long to wait after the user stops typing before firing the
/// search RPC. 250ms feels instantaneous in casual testing while
/// keeping the daemon from running grep on every keystroke.
const SEARCH_DEBOUNCE_MS = 250;

/// Server clamps to MAX_SEARCH_RESULTS_HARD_CAP=10k; 200 is the
/// default per the Rust side (DEFAULT_MAX_SEARCH_RESULTS) and
/// matches what a "scrollable result panel" can actually render
/// before the user gives up scrolling.
const MAX_RESULTS = 200;

export type WorkspaceSearchPanelProps = {
	isOpen: boolean;
	onClose: () => void;
	/**
	 * Absolute workspace root. Forwarded to `searchWorkspace` verbatim
	 * — local workspaces interpret it as a local FS path, remote ones
	 * interpret it on the remote filesystem.
	 */
	workspaceDir: string | null;
	workspaceId: string | null;
	/**
	 * Bound runtime name. `null` / `"local"` runs the search in-process;
	 * any other value resolves through the registry and dispatches
	 * `workspace.search` over the wire.
	 */
	runtimeName: string | null;
	/**
	 * Called when the user activates a match (click or Enter). The
	 * `lineNumber` is 1-indexed (git grep convention).
	 */
	onOpenResult: (relativePath: string, lineNumber: number) => void;
};

export function WorkspaceSearchPanel(props: WorkspaceSearchPanelProps) {
	const {
		isOpen,
		onClose,
		workspaceDir,
		workspaceId,
		runtimeName,
		onOpenResult,
	} = props;
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [caseInsensitive, setCaseInsensitive] = useState(true);
	const [fixedString, setFixedString] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const queryInputId = useId();

	// Reset internal state every time the panel opens. Stale results
	// from a previous workspace would be confusing; the activeIndex
	// must point at the first hit of the new result set.
	useEffect(() => {
		if (!isOpen) return;
		setQuery("");
		setDebouncedQuery("");
		setActiveIndex(0);
		// Focus the input on the next tick so the createPortal mount
		// completes before we try to focus.
		const tid = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(tid);
	}, [isOpen]);

	// Debounce: only push the query into the React Query key after
	// the user stops typing. The query is what the queryKey depends
	// on, so this keeps useQuery from refetching on every keystroke.
	useEffect(() => {
		if (!isOpen) return;
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			setDebouncedQuery("");
			return;
		}
		const tid = window.setTimeout(
			() => setDebouncedQuery(trimmed),
			SEARCH_DEBOUNCE_MS,
		);
		return () => window.clearTimeout(tid);
	}, [query, isOpen]);

	const queryEnabled =
		isOpen && Boolean(workspaceDir) && debouncedQuery.length > 0;

	const searchQuery = useQuery<WorkspaceSearchResult>({
		queryKey: [
			"workspaceSearch",
			workspaceId ?? "",
			workspaceDir ?? "",
			runtimeName ?? "",
			debouncedQuery,
			caseInsensitive,
			fixedString,
		],
		queryFn: () =>
			searchWorkspace({
				workspaceDir: workspaceDir ?? "",
				query: debouncedQuery,
				maxResults: MAX_RESULTS,
				caseInsensitive,
				fixedString,
				workspaceId: workspaceId ?? undefined,
				runtimeName: runtimeName ?? undefined,
			}),
		enabled: queryEnabled,
		// Search results don't need persistence + shouldn't go stale
		// — the watcher fires `WorkspaceFilesChanged` which the bridge
		// invalidates, so re-opening the panel on a changed workspace
		// gets fresh hits without manual refetching here.
		staleTime: 30_000,
		retry: false,
	});

	const matches = searchQuery.data?.matches ?? [];
	const truncated = searchQuery.data?.truncated ?? false;

	// Clamp activeIndex into the valid range whenever the result set
	// shrinks under us — without this an out-of-range index would
	// render no row as active until the user pressed an arrow key.
	useEffect(() => {
		if (activeIndex >= matches.length) {
			setActiveIndex(matches.length > 0 ? matches.length - 1 : 0);
		}
	}, [activeIndex, matches.length]);

	// Keyboard nav: ArrowUp/Down to move, Enter to open the active
	// row, plain typing stays in the input. The handler lives on the
	// outer container so it fires regardless of which child has
	// focus.
	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (matches.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((idx) => (idx + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((idx) => (idx - 1 + matches.length) % matches.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const match = matches[activeIndex];
			if (match) {
				onOpenResult(match.relativePath, match.lineNumber);
				onClose();
			}
		}
	};

	const status = useMemo(() => {
		if (!workspaceDir) {
			return {
				tone: "info" as const,
				text: "Open a workspace to start searching.",
			};
		}
		if (debouncedQuery.length === 0) {
			return {
				tone: "info" as const,
				text: "Type to search across the workspace's tracked files.",
			};
		}
		if (searchQuery.isFetching) {
			return { tone: "loading" as const, text: "Searching…" };
		}
		if (searchQuery.error) {
			return {
				tone: "error" as const,
				text: errorMessage(searchQuery.error),
			};
		}
		if (matches.length === 0) {
			return {
				tone: "info" as const,
				text: `No matches for "${debouncedQuery}".`,
			};
		}
		const suffix = truncated ? ` (capped at ${MAX_RESULTS})` : "";
		return {
			tone: "ok" as const,
			text: `${matches.length} match${matches.length === 1 ? "" : "es"}${suffix}`,
		};
	}, [
		workspaceDir,
		debouncedQuery,
		searchQuery.isFetching,
		searchQuery.error,
		matches.length,
		truncated,
	]);

	if (!isOpen) return null;
	if (typeof document === "undefined") return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[70] grid place-items-start bg-black/30 pt-[10vh] supports-backdrop-filter:backdrop-blur-sm"
			data-testid="workspace-search-panel"
			role="dialog"
			aria-modal="true"
			aria-label="Search workspace files"
			onClick={(e) => {
				// Click on the dimmed backdrop (but not inside the
				// dialog) closes the panel — same affordance as a
				// standard modal.
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={handleKeyDown}
		>
			<div className="flex max-h-[80vh] w-[min(720px,90vw)] flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10">
				<header className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
					<FileSearch
						className="size-4 text-muted-foreground"
						strokeWidth={1.8}
						aria-hidden
					/>
					<label htmlFor={queryInputId} className="sr-only">
						Search workspace files
					</label>
					<Input
						id={queryInputId}
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						placeholder="Search files…"
						spellCheck={false}
						autoComplete="off"
						className="h-9 flex-1 border-0 bg-transparent px-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
					/>
					<button
						type="button"
						onClick={() => setCaseInsensitive((v) => !v)}
						aria-label={
							caseInsensitive
								? "Disable case-insensitive matching"
								: "Enable case-insensitive matching"
						}
						aria-pressed={caseInsensitive}
						className={cn(
							"flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground",
							"hover:bg-foreground/5 hover:text-foreground",
							caseInsensitive && "bg-primary/15 text-primary",
						)}
					>
						<CaseSensitive className="size-4" strokeWidth={1.8} />
					</button>
					<button
						type="button"
						onClick={() => setFixedString((v) => !v)}
						aria-label={
							fixedString
								? "Switch to regex matching"
								: "Switch to fixed-string matching"
						}
						aria-pressed={!fixedString}
						className={cn(
							"flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground",
							"hover:bg-foreground/5 hover:text-foreground",
							!fixedString && "bg-primary/15 text-primary",
						)}
					>
						<Regex className="size-4" strokeWidth={1.8} />
					</button>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close search"
						className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
					>
						<X className="size-4" strokeWidth={1.8} />
					</button>
				</header>

				<div className="flex items-center gap-2 border-b border-border/30 px-4 py-1.5 text-[11px]">
					{status.tone === "loading" ? (
						<Loader2 className="size-3 animate-spin" />
					) : null}
					<span
						className={cn(
							"truncate",
							status.tone === "error" && "text-destructive",
							status.tone === "info" && "text-muted-foreground",
							status.tone === "ok" && "text-foreground",
							status.tone === "loading" && "text-muted-foreground",
						)}
						data-testid="workspace-search-status"
					>
						{status.text}
					</span>
					{truncated ? (
						<span
							className="ml-auto inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase text-amber-300"
							data-testid="workspace-search-truncated-chip"
						>
							+more
						</span>
					) : null}
				</div>

				{matches.length > 0 && (
					<ul className="flex max-h-[60vh] flex-col overflow-y-auto py-1">
						{matches.map((match, index) => (
							<SearchResultRow
								key={`${match.relativePath}:${match.lineNumber}:${index}`}
								match={match}
								query={debouncedQuery}
								isActive={index === activeIndex}
								onSelect={() => setActiveIndex(index)}
								onOpen={() => {
									onOpenResult(match.relativePath, match.lineNumber);
									onClose();
								}}
							/>
						))}
					</ul>
				)}
			</div>
		</div>,
		document.body,
	);
}

function SearchResultRow({
	match,
	query,
	isActive,
	onSelect,
	onOpen,
}: {
	match: WorkspaceSearchMatch;
	query: string;
	isActive: boolean;
	onSelect: () => void;
	onOpen: () => void;
}) {
	const rowRef = useRef<HTMLLIElement>(null);

	// Scroll the active row into view when keyboard nav advances past
	// the visible window. Mirrors the quick-switch overlay's pattern.
	useEffect(() => {
		if (!isActive) return;
		rowRef.current?.scrollIntoView({ block: "nearest" });
	}, [isActive]);

	return (
		<li
			ref={rowRef}
			data-active={isActive ? "true" : undefined}
			data-testid={`workspace-search-result-${match.relativePath}-${match.lineNumber}`}
			className={cn(
				"group flex cursor-pointer items-baseline gap-2 px-4 py-1 text-sm",
				isActive ? "bg-primary/15 text-foreground" : "hover:bg-foreground/5",
			)}
			onClick={onOpen}
			onMouseMove={onSelect}
		>
			<span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
				{match.relativePath}:{match.lineNumber}
			</span>
			<span className="flex-1 truncate font-mono text-[12px]">
				{highlightMatch(match.line, query)}
			</span>
		</li>
	);
}

/// Wrap the first case-insensitive occurrence of `query` inside the
/// matched line with a `<mark>` tag so the panel renders the hit
/// inline the way users expect. Falls back to the raw line when no
/// match is found (defensive — git grep guarantees a match exists,
/// but a future regex case could plausibly elide one).
function highlightMatch(line: string, query: string) {
	if (query.length === 0) return line;
	const haystack = line.toLowerCase();
	const needle = query.toLowerCase();
	const idx = haystack.indexOf(needle);
	if (idx < 0) return line;
	const before = line.slice(0, idx);
	const hit = line.slice(idx, idx + query.length);
	const after = line.slice(idx + query.length);
	return (
		<>
			{before}
			<mark className="rounded-sm bg-yellow-500/30 px-0.5 text-foreground">
				{hit}
			</mark>
			{after}
		</>
	);
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err && typeof err === "object" && "message" in err) {
		return String((err as { message?: unknown }).message);
	}
	return "Search failed.";
}
