import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import {
	getScriptState,
	subscribeStatus,
} from "@/features/inspector/script-store";
import {
	getTerminalDisplayTitle,
	getTerminals,
	subscribeToWorkspaceList,
} from "@/features/inspector/terminal-store";
import {
	getTerminalSessionsForWorkspace,
	subscribeToWorkspaceTerminalSessions,
} from "@/features/terminal/terminal-session-store";
import type {
	ExtendedMessagePart,
	RepoScripts,
	TaskState,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";
import { loadRepoScripts } from "@/lib/api";
import {
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
} from "@/lib/query-client";

const EMPTY_TASKS: readonly TaskState[] = Object.freeze([]);
const EMPTY_RUN_ACTIONS = Object.freeze([]);

export type BackgroundFallbackItem = {
	id: string;
	kind: "script" | "inspector-terminal" | "terminal-session";
	title: string;
	typeKey: string;
	command?: string | null;
	status: "running";
};

/** A task plus the tool call it rides on — the tool carries the command /
 *  prompt (`args`) and the raw output (`result`) that TaskState lacks. Live
 *  streaming snapshots have no tool part, so `tool` is nullable. */
export type BackgroundTask = {
	state: TaskState;
	tool: ToolCallPart | null;
};

export type BackgroundTasksData =
	| { mode: "hidden"; tasks: readonly BackgroundTask[]; fallbacks: readonly [] }
	| { mode: "tasks"; tasks: readonly BackgroundTask[]; fallbacks: readonly [] }
	| {
			mode: "fallbacks";
			tasks: readonly [];
			fallbacks: readonly BackgroundFallbackItem[];
	  };

function collectToolTaskState(
	part: ToolCallPart,
	tasksById: Map<string, BackgroundTask>,
) {
	if (part.taskState) {
		tasksById.set(part.taskState.id, { state: part.taskState, tool: part });
	}
	for (const child of part.children ?? []) {
		collectTaskStateFromPart(child, tasksById);
	}
}

function collectTaskStateFromPart(
	part: ExtendedMessagePart,
	tasksById: Map<string, BackgroundTask>,
) {
	if (part.type === "tool-call") {
		collectToolTaskState(part, tasksById);
		return;
	}
	if (part.type === "collapsed-group") {
		for (const tool of part.tools) collectToolTaskState(tool, tasksById);
	}
}

export function extractTaskStatesFromMessages(
	messages: readonly ThreadMessageLike[],
): BackgroundTask[] {
	const tasksById = new Map<string, BackgroundTask>();
	for (const message of messages) {
		for (const part of message.content) {
			collectTaskStateFromPart(part, tasksById);
		}
	}
	return Array.from(tasksById.values());
}

function runningScriptFallbacks(
	workspaceId: string | null | undefined,
	repoScripts: RepoScripts | null | undefined,
): BackgroundFallbackItem[] {
	if (!workspaceId || !repoScripts) return [];
	const items: BackgroundFallbackItem[] = [];
	// Setup is workspace initialization with its own inspector status/output,
	// not background work owned by the active chat session. Keep this fallback
	// focused on long-lived Run actions and terminals.
	for (const action of repoScripts.runActions) {
		if (!action.command.trim()) continue;
		const run = getScriptState(workspaceId, "run", action.id);
		if (run?.status === "running") {
			items.push({
				id: `${workspaceId}:run:${action.id}`,
				kind: "script",
				title: action.name.trim() || "run",
				typeKey: "taskPanelTypeScript",
				command: action.command,
				status: "running",
			});
		}
	}
	return items;
}

function useScriptFallbacks(
	workspaceId: string | null | undefined,
	repoScripts: RepoScripts | null | undefined,
	enabled: boolean,
): BackgroundFallbackItem[] {
	const [items, setItems] = useState<BackgroundFallbackItem[]>(() =>
		enabled ? runningScriptFallbacks(workspaceId, repoScripts) : [],
	);
	const runActions = repoScripts?.runActions ?? EMPTY_RUN_ACTIONS;
	const runActionKey = runActions.map((action) => action.id).join("|");

	useEffect(() => {
		if (!enabled || !workspaceId || !repoScripts) {
			setItems([]);
			return;
		}
		const refresh = () => {
			setItems(runningScriptFallbacks(workspaceId, repoScripts));
		};
		refresh();
		const unsubscribers: Array<() => void> = [];
		for (const action of runActions) {
			unsubscribers.push(
				subscribeStatus(workspaceId, "run", refresh, action.id),
			);
		}
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [enabled, repoScripts, runActions, runActionKey, workspaceId]);

	return items;
}

function useInspectorTerminalFallbacks(
	workspaceId: string | null | undefined,
	enabled: boolean,
): BackgroundFallbackItem[] {
	const read = useMemo(
		() => () => {
			if (!enabled || !workspaceId) return [];
			const terminals = getTerminals(workspaceId);
			return terminals
				.map((terminal, index) => ({
					terminal,
					index,
					total: terminals.length,
				}))
				.filter(({ terminal }) => terminal.status === "running")
				.map(({ terminal, index, total }) => ({
					id: `${workspaceId}:terminal:${terminal.id}`,
					kind: "inspector-terminal" as const,
					title: getTerminalDisplayTitle(index, total),
					typeKey: "taskPanelTypeTerminal",
					status: "running" as const,
				}));
		},
		[enabled, workspaceId],
	);
	const [items, setItems] = useState<BackgroundFallbackItem[]>(read);

	useEffect(() => {
		if (!enabled || !workspaceId) {
			setItems([]);
			return;
		}
		const refresh = () => setItems(read());
		return subscribeToWorkspaceList(workspaceId, refresh);
	}, [enabled, read, workspaceId]);

	return items;
}

function useTerminalSessionFallbacks(
	workspaceId: string | null | undefined,
	enabled: boolean,
): BackgroundFallbackItem[] {
	const read = useMemo(
		() => () => {
			if (!enabled || !workspaceId) return [];
			return getTerminalSessionsForWorkspace(workspaceId)
				.filter((session) => session.status === "running")
				.map((session) => ({
					id: `${workspaceId}:terminal-session:${session.sessionId}`,
					kind: "terminal-session" as const,
					title: session.agentKind ?? "terminalMode",
					typeKey: "taskPanelTypeTerminal",
					command: session.bootCommand,
					status: "running" as const,
				}));
		},
		[enabled, workspaceId],
	);
	const [items, setItems] = useState<BackgroundFallbackItem[]>(read);

	useEffect(() => {
		if (!enabled || !workspaceId) {
			setItems([]);
			return;
		}
		const refresh = () => setItems(read());
		return subscribeToWorkspaceTerminalSessions(workspaceId, refresh);
	}, [enabled, read, workspaceId]);

	return items;
}

/**
 * Session background-task feed for the composer task panel. Live tasks come
 * from the streaming store during a turn; historical terminal states are
 * re-derived from the rendered thread cache (same source the conversation
 * reads). When the session has no tasks at all, running workspace processes
 * (scripts / terminals) surface as fallback items.
 */
export function useBackgroundTasks({
	sessionId,
	workspaceId,
	repoId,
}: {
	sessionId: string | null;
	workspaceId?: string | null;
	repoId?: string | null;
}): BackgroundTasksData {
	const activeTasks = useStreamingStore((state) =>
		sessionId
			? (state.activeTasksBySession[sessionId] ?? EMPTY_TASKS)
			: EMPTY_TASKS,
	);
	const { data: messages } = useQuery({
		...sessionThreadMessagesQueryOptions(sessionId ?? ""),
		enabled: !!sessionId,
	});
	const historicalTasks = useMemo(
		() => extractTaskStatesFromMessages(messages ?? []),
		[messages],
	);
	const tasks = useMemo(() => {
		// Merge: live states win over their historical snapshots, but historical
		// tasks from earlier turns stay listed alongside the current turn's. The
		// tool part (command/prompt/output) only exists on the historical side,
		// so live states graft onto it when both are present.
		if (activeTasks.length === 0) return historicalTasks;
		const byId = new Map<string, BackgroundTask>();
		for (const task of historicalTasks) byId.set(task.state.id, task);
		for (const state of activeTasks) {
			byId.set(state.id, { state, tool: byId.get(state.id)?.tool ?? null });
		}
		return Array.from(byId.values());
	}, [activeTasks, historicalTasks]);
	const fallbackEnabled = tasks.length === 0;
	// Scripts are only needed for fallback mode — don't fetch (or refetch on
	// window focus) while real tasks own the panel.
	const { data: repoScripts } = useQuery({
		queryKey: helmorQueryKeys.repoScripts(
			repoId ?? "__none__",
			workspaceId ?? null,
		),
		queryFn: () => loadRepoScripts(repoId!, workspaceId ?? null),
		enabled: fallbackEnabled && Boolean(repoId && workspaceId),
		staleTime: 30_000,
	});
	const scriptFallbacks = useScriptFallbacks(
		workspaceId,
		repoScripts,
		fallbackEnabled,
	);
	const inspectorTerminalFallbacks = useInspectorTerminalFallbacks(
		workspaceId,
		fallbackEnabled,
	);
	const terminalSessionFallbacks = useTerminalSessionFallbacks(
		workspaceId,
		fallbackEnabled,
	);

	return useMemo(() => {
		if (tasks.length > 0) {
			return { mode: "tasks", tasks, fallbacks: [] };
		}
		const fallbacks = [
			...scriptFallbacks,
			...inspectorTerminalFallbacks,
			...terminalSessionFallbacks,
		];
		if (fallbacks.length > 0) {
			return { mode: "fallbacks", tasks: [], fallbacks };
		}
		return { mode: "hidden", tasks: [], fallbacks: [] };
	}, [
		inspectorTerminalFallbacks,
		scriptFallbacks,
		tasks,
		terminalSessionFallbacks,
	]);
}
