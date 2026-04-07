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

declare global {
	interface Window {
		__HELMOR_DEV_RENDER_STATS__?: DevRenderStats;
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
