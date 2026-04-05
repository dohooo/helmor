type DevRenderStats = {
	composer: {
		rendersByContext: Record<string, number>;
		instanceIdsByContext: Record<string, string[]>;
	};
	sidebarRows: Record<string, number>;
	messageRows: {
		rendersBySession: Record<string, number>;
		rendersByMessageId: Record<string, number>;
		rendersBySessionMessageId: Record<string, Record<string, number>>;
	};
};

type DevHeapStats = {
	usedJSHeapSize: number;
	totalJSHeapSize: number;
	jsHeapSizeLimit: number;
};

type DevChatCachePaneStats = {
	workspaceId: string | null;
	messageCount: number;
	estimatedMessageBytes: number;
	sending: boolean;
	hasLoaded: boolean;
	presentationState: "cold-unpresented" | "presented";
	hasViewportSnapshot: boolean;
	layoutCacheKey: string | null;
	lastMeasuredAt?: number;
};

type DevChatCacheSnapshot = {
	timestamp: string;
	paneLimit: number;
	visibleSessionId: string | null;
	preparingSessionId: string | null;
	threadSessionId: string | null;
	hotPaneCount: number;
	warmEntryCount: number;
	totalRetainedMessages: number;
	totalEstimatedMessageBytes: number;
	querySessionMessageCount: number;
	querySessionMessageObserverCount: number;
	querySessionMessageDataMessages: number;
	paneOrder: string[];
	warmSessionIds: string[];
	panesBySession: Record<string, DevChatCachePaneStats>;
	heapStats: DevHeapStats | null;
};

type DevChatCacheController = {
	latest: DevChatCacheSnapshot | null;
	history: DevChatCacheSnapshot[];
	printLatest: () => void;
	resetHistory: () => void;
};

declare global {
	interface Window {
		__HELMOR_DEV_RENDER_STATS__?: DevRenderStats;
		__HELMOR_DEV_CACHE_STATS__?: DevChatCacheController;
	}
}

function hasDebugFlag(flag: string) {
	if (!import.meta.env.DEV || typeof window === "undefined") {
		return false;
	}

	const params = new URLSearchParams(window.location.search);
	return params.get(flag) === "1";
}

function shouldTrackDevRenders() {
	return hasDebugFlag("debugRenderCounts");
}

export function shouldTrackDevCacheStats() {
	if (!import.meta.env.DEV || typeof window === "undefined") {
		return false;
	}

	return (
		import.meta.env.VITE_HELMOR_ANALYZE === "1" ||
		hasDebugFlag("debugCacheStats") ||
		hasDebugFlag("debugRenderCounts")
	);
}

function ensureStats(): DevRenderStats | null {
	if (!shouldTrackDevRenders()) {
		return null;
	}

	if (!window.__HELMOR_DEV_RENDER_STATS__) {
		window.__HELMOR_DEV_RENDER_STATS__ = {
			composer: {
				rendersByContext: {},
				instanceIdsByContext: {},
			},
			sidebarRows: {},
			messageRows: {
				rendersBySession: {},
				rendersByMessageId: {},
				rendersBySessionMessageId: {},
			},
		};
	}

	return window.__HELMOR_DEV_RENDER_STATS__;
}

function getHeapStats(): DevHeapStats | null {
	if (typeof performance === "undefined") {
		return null;
	}

	const performanceWithMemory = performance as Performance & {
		memory?: DevHeapStats;
	};

	if (!performanceWithMemory.memory) {
		return null;
	}

	return {
		usedJSHeapSize: performanceWithMemory.memory.usedJSHeapSize,
		totalJSHeapSize: performanceWithMemory.memory.totalJSHeapSize,
		jsHeapSizeLimit: performanceWithMemory.memory.jsHeapSizeLimit,
	};
}

function ensureChatCacheController(): DevChatCacheController | null {
	if (!shouldTrackDevCacheStats()) {
		return null;
	}

	if (!window.__HELMOR_DEV_CACHE_STATS__) {
		window.__HELMOR_DEV_CACHE_STATS__ = {
			latest: null,
			history: [],
			printLatest() {
				const latest = window.__HELMOR_DEV_CACHE_STATS__?.latest;
				if (!latest) {
					console.info("[helmor] no chat cache stats collected yet");
					return;
				}

				console.groupCollapsed(
					`[helmor] chat cache hot=${latest.hotPaneCount}/${latest.paneLimit} warm=${latest.warmEntryCount} retained=${latest.totalRetainedMessages} msgs`,
				);
				console.log(latest);
				console.table(
					Object.entries(latest.panesBySession).map(([sessionId, pane]) => ({
						sessionId,
						workspaceId: pane.workspaceId,
						messageCount: pane.messageCount,
						estimatedMessageKB: Number(
							(pane.estimatedMessageBytes / 1024).toFixed(1),
						),
						sending: pane.sending,
						hasLoaded: pane.hasLoaded,
						presentationState: pane.presentationState,
						hasViewportSnapshot: pane.hasViewportSnapshot,
					})),
				);
				console.groupEnd();
			},
			resetHistory() {
				if (!window.__HELMOR_DEV_CACHE_STATS__) {
					return;
				}

				window.__HELMOR_DEV_CACHE_STATS__.latest = null;
				window.__HELMOR_DEV_CACHE_STATS__.history = [];
			},
		};
	}

	return window.__HELMOR_DEV_CACHE_STATS__;
}

export function recordComposerRender(contextKey: string, instanceId: string) {
	const stats = ensureStats();
	if (!stats) {
		return;
	}

	stats.composer.rendersByContext[contextKey] =
		(stats.composer.rendersByContext[contextKey] ?? 0) + 1;
	const instanceIds = stats.composer.instanceIdsByContext[contextKey] ?? [];
	if (!instanceIds.includes(instanceId)) {
		instanceIds.push(instanceId);
	}
	stats.composer.instanceIdsByContext[contextKey] = instanceIds;
}

export function recordSidebarRowRender(rowId: string) {
	const stats = ensureStats();
	if (!stats) {
		return;
	}

	stats.sidebarRows[rowId] = (stats.sidebarRows[rowId] ?? 0) + 1;
}

export function recordMessageRender(sessionId: string, messageId: string) {
	const stats = ensureStats();
	if (!stats) {
		return;
	}

	stats.messageRows.rendersBySession[sessionId] =
		(stats.messageRows.rendersBySession[sessionId] ?? 0) + 1;
	stats.messageRows.rendersByMessageId[messageId] =
		(stats.messageRows.rendersByMessageId[messageId] ?? 0) + 1;

	const sessionRows =
		stats.messageRows.rendersBySessionMessageId[sessionId] ?? {};
	sessionRows[messageId] = (sessionRows[messageId] ?? 0) + 1;
	stats.messageRows.rendersBySessionMessageId[sessionId] = sessionRows;
}

export function publishChatCacheSnapshot(
	snapshot: Omit<DevChatCacheSnapshot, "timestamp" | "heapStats">,
) {
	const controller = ensureChatCacheController();
	if (!controller) {
		return;
	}

	const nextSnapshot: DevChatCacheSnapshot = {
		...snapshot,
		timestamp: new Date().toISOString(),
		heapStats: getHeapStats(),
	};
	controller.latest = nextSnapshot;
	controller.history = [...controller.history.slice(-49), nextSnapshot];
}
