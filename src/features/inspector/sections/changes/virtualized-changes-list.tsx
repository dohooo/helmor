import {
	type Range,
	useVirtualizer,
	type Virtualizer,
} from "@tanstack/react-virtual";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";
import type {
	ChangeGroupId,
	ChangeListCommonProps,
	ChangeListGroup,
} from "./types";
import {
	buildGroupLookup,
	buildTreeData,
	type ChangePanelRow,
	createChangePanelRows,
	type ExpansionEntry,
	estimateChangeRowHeight,
	getChangeRowKey,
} from "./virtualized-row-model";
import { renderChangePanelRow } from "./virtualized-row-renderer";

const CHANGE_LIST_LEADING_OVERSCAN_ROWS = 6;
const CHANGE_LIST_TRAILING_OVERSCAN_ROWS = 56;
const CHANGE_LIST_IDLE_OVERSCAN_ROWS = 24;

type ScrollDirection = "forward" | "backward" | null;

export function VirtualizedChangesList({
	groups,
	className,
	...common
}: {
	groups: ChangeListGroup[];
	className?: string;
} & ChangeListCommonProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const scrollDirectionRef = useRef<ScrollDirection>(null);
	const scrollingRowCacheRef = useRef(new Map<unknown, ReactNode>());
	const cachedRowsRef = useRef<ChangePanelRow[] | null>(null);
	const treeData = useMemo(() => buildTreeData(groups), [groups]);
	const groupLookup = useMemo(() => buildGroupLookup(groups), [groups]);
	const [expansionByGroup, setExpansionByGroup] = useState<
		Partial<Record<ChangeGroupId, ExpansionEntry>>
	>({});

	useEffect(() => {
		setExpansionByGroup((previous) => {
			let changed = false;
			const next: Partial<Record<ChangeGroupId, ExpansionEntry>> = {
				...previous,
			};
			for (const group of groups) {
				const data = treeData.get(group.id);
				if (!data) continue;
				const existing = previous[group.id];
				if (!existing || existing.signature !== data.signature) {
					next[group.id] = {
						signature: data.signature,
						expanded: data.allFolders,
					};
					changed = true;
				}
			}
			return changed ? next : previous;
		});
	}, [groups, treeData]);

	const toggleFolder = useCallback((groupId: ChangeGroupId, path: string) => {
		setExpansionByGroup((previous) => {
			const existing = previous[groupId];
			const expanded = new Set(existing?.expanded ?? []);
			if (expanded.has(path)) {
				expanded.delete(path);
			} else {
				expanded.add(path);
			}
			return {
				...previous,
				[groupId]: {
					signature: existing?.signature ?? "",
					expanded,
				},
			};
		});
	}, []);

	const rangeExtractor = useCallback(
		(range: Range) =>
			extractDirectionalRange(range, scrollDirectionRef.current),
		[],
	);
	const handleVirtualizerChange = useCallback(
		(instance: Virtualizer<HTMLDivElement, Element>) => {
			scrollDirectionRef.current = instance.scrollDirection;
		},
		[],
	);
	const rows = useMemo(
		() => createChangePanelRows({ groups, treeData, expansionByGroup }),
		[groups, treeData, expansionByGroup],
	);
	if (cachedRowsRef.current !== rows) {
		scrollingRowCacheRef.current.clear();
		cachedRowsRef.current = rows;
	}

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => estimateChangeRowHeight(rows[index]),
		getItemKey: (index) => getChangeRowKey(rows[index]),
		overscan: CHANGE_LIST_TRAILING_OVERSCAN_ROWS,
		rangeExtractor,
		isScrollingResetDelay: 150,
		onChange: handleVirtualizerChange,
	});
	scrollDirectionRef.current = virtualizer.scrollDirection;
	const isScrolling = virtualizer.isScrolling;
	const animationViewport = getAnimationViewport(scrollRef.current);
	useEffect(() => {
		if (!isScrolling) {
			scrollingRowCacheRef.current.clear();
		}
	}, [isScrolling]);

	return (
		<div
			ref={scrollRef}
			aria-label="Changes panel body"
			className={cn(
				"scrollbar-stable min-h-0 flex-1 overflow-y-auto bg-muted/20 font-mono text-mini [scrollbar-width:thin]",
				className,
			)}
		>
			<div
				style={{
					height: `${virtualizer.getTotalSize()}px`,
					position: "relative",
					pointerEvents: isScrolling ? "none" : undefined,
					width: "100%",
				}}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const row = rows[virtualRow.index];
					const animationsEnabled =
						!isScrolling &&
						isVirtualRowInViewport(virtualRow, animationViewport);
					const renderedRow = getRenderedRow({
						cache: scrollingRowCacheRef.current,
						cacheKey: virtualRow.key,
						cacheable: isScrolling,
						row,
						groupLookup,
						common,
						toggleFolder,
						animationsEnabled,
						interactionsEnabled: !isScrolling,
					});
					return (
						<div
							key={virtualRow.key}
							className={getVirtualRowAnimationClass(row, groupLookup)}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: `${virtualRow.size}px`,
								transform: `translate3d(0, ${virtualRow.start}px, 0)`,
							}}
						>
							{renderedRow}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function getRenderedRow({
	cache,
	cacheKey,
	cacheable,
	row,
	groupLookup,
	common,
	toggleFolder,
	animationsEnabled,
	interactionsEnabled,
}: {
	cache: Map<unknown, ReactNode>;
	cacheKey: unknown;
	cacheable: boolean;
	row: ChangePanelRow;
	groupLookup: Map<ChangeGroupId, ChangeListGroup>;
	common: ChangeListCommonProps;
	toggleFolder: (groupId: ChangeGroupId, path: string) => void;
	animationsEnabled: boolean;
	interactionsEnabled: boolean;
}) {
	if (cacheable && cache.has(cacheKey)) {
		return cache.get(cacheKey);
	}
	const rendered = renderChangePanelRow({
		row,
		groupLookup,
		common,
		toggleFolder,
		animationsEnabled,
		interactionsEnabled,
	});
	if (cacheable) {
		cache.set(cacheKey, rendered);
	}
	return rendered;
}

function extractDirectionalRange(range: Range, direction: ScrollDirection) {
	const before =
		direction === "backward"
			? CHANGE_LIST_TRAILING_OVERSCAN_ROWS
			: direction === "forward"
				? CHANGE_LIST_LEADING_OVERSCAN_ROWS
				: CHANGE_LIST_IDLE_OVERSCAN_ROWS;
	const after =
		direction === "forward"
			? CHANGE_LIST_TRAILING_OVERSCAN_ROWS
			: direction === "backward"
				? CHANGE_LIST_LEADING_OVERSCAN_ROWS
				: CHANGE_LIST_IDLE_OVERSCAN_ROWS;
	const start = Math.max(0, range.startIndex - before);
	const end = Math.min(range.count - 1, range.endIndex + after);
	const indexes: number[] = [];
	for (let index = start; index <= end; index += 1) {
		indexes.push(index);
	}
	return indexes;
}

type AnimationViewport = {
	start: number;
	end: number;
} | null;

function getAnimationViewport(
	scrollElement: HTMLDivElement | null,
): AnimationViewport {
	if (!scrollElement || scrollElement.clientHeight <= 0) {
		return null;
	}
	return {
		start: scrollElement.scrollTop,
		end: scrollElement.scrollTop + scrollElement.clientHeight,
	};
}

function isVirtualRowInViewport(
	row: { start: number; size: number },
	viewport: AnimationViewport,
) {
	if (!viewport) {
		return true;
	}
	return row.start < viewport.end && row.start + row.size > viewport.start;
}

function getVirtualRowAnimationClass(
	row: ChangePanelRow,
	groupLookup: Map<ChangeGroupId, ChangeListGroup>,
) {
	const groupId = getContentRowGroupId(row);
	if (!groupId) {
		return undefined;
	}
	const group = groupLookup.get(groupId);
	return cn(
		"transition-opacity duration-150",
		group?.loading && "pointer-events-none opacity-40",
	);
}

function getContentRowGroupId(row: ChangePanelRow) {
	switch (row.kind) {
		case "loading":
		case "tree-folder":
		case "tree-file":
		case "flat-file":
			return row.groupId;
		case "group-header":
		case "empty":
			return null;
	}
}
