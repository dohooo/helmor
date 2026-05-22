import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AutoSizer,
	List,
	type ListRowProps,
	type OverscanIndicesGetterParams,
} from "react-virtualized";
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
const SCROLLING_ROW_CACHE_RESET_MS = 170;

const SCROLL_DIRECTION_BACKWARD = -1;
const SCROLL_DIRECTION_FORWARD = 1;

type CachedRenderInputs = {
	rows: ChangePanelRow[];
	groupLookup: Map<ChangeGroupId, ChangeListGroup>;
	common: ChangeListCommonProps;
};

export function VirtualizedChangesList({
	groups,
	className,
	editorMode,
	activeEditor,
	onOpenEditorFile,
	onOpenExternalEditor,
	flashingPaths,
	workspaceBranch,
	workspaceRemoteUrl,
}: {
	groups: ChangeListGroup[];
	className?: string;
} & ChangeListCommonProps) {
	const scrollingRowCacheRef = useRef(new Map<unknown, ReactNode>());
	const cachedRenderInputsRef = useRef<CachedRenderInputs | null>(null);
	const scrollCacheClearTimerRef = useRef<number | null>(null);
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

	const rows = useMemo(
		() => createChangePanelRows({ groups, treeData, expansionByGroup }),
		[groups, treeData, expansionByGroup],
	);
	const common = useMemo(
		() => ({
			editorMode,
			activeEditor,
			onOpenEditorFile,
			onOpenExternalEditor,
			flashingPaths,
			workspaceBranch,
			workspaceRemoteUrl,
		}),
		[
			editorMode,
			activeEditor,
			onOpenEditorFile,
			onOpenExternalEditor,
			flashingPaths,
			workspaceBranch,
			workspaceRemoteUrl,
		],
	);
	const cachedRenderInputs = cachedRenderInputsRef.current;
	if (
		!cachedRenderInputs ||
		cachedRenderInputs.rows !== rows ||
		cachedRenderInputs.groupLookup !== groupLookup ||
		cachedRenderInputs.common !== common
	) {
		scrollingRowCacheRef.current.clear();
		cachedRenderInputsRef.current = { rows, groupLookup, common };
	}

	const handleScroll = useCallback(() => {
		if (typeof window === "undefined") {
			scrollingRowCacheRef.current.clear();
			return;
		}
		if (scrollCacheClearTimerRef.current !== null) {
			window.clearTimeout(scrollCacheClearTimerRef.current);
		}
		scrollCacheClearTimerRef.current = window.setTimeout(() => {
			scrollingRowCacheRef.current.clear();
			scrollCacheClearTimerRef.current = null;
		}, SCROLLING_ROW_CACHE_RESET_MS);
	}, []);
	useEffect(
		() => () => {
			if (
				typeof window !== "undefined" &&
				scrollCacheClearTimerRef.current !== null
			) {
				window.clearTimeout(scrollCacheClearTimerRef.current);
			}
		},
		[],
	);

	const rowHeight = useCallback(
		({ index }: { index: number }) => {
			const row = rows[index];
			return row ? estimateChangeRowHeight(row) : 0;
		},
		[rows],
	);
	const rowRenderer = useCallback(
		({ index, key, style, isScrolling, isVisible }: ListRowProps) => {
			const row = rows[index];
			if (!row) {
				return null;
			}
			const renderedRow = getRenderedRow({
				cache: scrollingRowCacheRef.current,
				cacheKey: getChangeRowKey(row),
				cacheable: isScrolling,
				row,
				groupLookup,
				common,
				toggleFolder,
				animationsEnabled: !isScrolling && isVisible,
				interactionsEnabled: !isScrolling,
			});
			return (
				<div
					key={key}
					className={getVirtualRowAnimationClass(row, groupLookup)}
					style={style}
				>
					{renderedRow}
				</div>
			);
		},
		[rows, groupLookup, common, toggleFolder],
	);

	return (
		<div
			aria-label="Changes panel body"
			className={cn(
				"min-h-0 flex-1 bg-muted/20 font-mono text-mini",
				className,
			)}
		>
			<AutoSizer>
				{({ width, height }) =>
					width > 0 && height > 0 ? (
						<List
							aria-label="Changes panel body"
							className="scrollbar-stable [scrollbar-width:thin]"
							height={height}
							overscanIndicesGetter={getDirectionalOverscanIndices}
							overscanRowCount={CHANGE_LIST_TRAILING_OVERSCAN_ROWS}
							rowCount={rows.length}
							rowHeight={rowHeight}
							rowRenderer={rowRenderer}
							onScroll={handleScroll}
							scrollingResetTimeInterval={150}
							style={{ outline: "none" }}
							width={width}
						/>
					) : null
				}
			</AutoSizer>
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

function getDirectionalOverscanIndices({
	cellCount,
	scrollDirection,
	startIndex,
	stopIndex,
}: OverscanIndicesGetterParams) {
	const before =
		scrollDirection === SCROLL_DIRECTION_BACKWARD
			? CHANGE_LIST_TRAILING_OVERSCAN_ROWS
			: scrollDirection === SCROLL_DIRECTION_FORWARD
				? CHANGE_LIST_LEADING_OVERSCAN_ROWS
				: CHANGE_LIST_IDLE_OVERSCAN_ROWS;
	const after =
		scrollDirection === SCROLL_DIRECTION_FORWARD
			? CHANGE_LIST_TRAILING_OVERSCAN_ROWS
			: scrollDirection === SCROLL_DIRECTION_BACKWARD
				? CHANGE_LIST_LEADING_OVERSCAN_ROWS
				: CHANGE_LIST_IDLE_OVERSCAN_ROWS;
	return {
		overscanStartIndex: Math.max(0, startIndex - before),
		overscanStopIndex: Math.min(cellCount - 1, stopIndex + after),
	};
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
