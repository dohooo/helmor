import "./App.css";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import { Moon, Sun } from "lucide-react";
import {
  DEFAULT_AGENT_MODEL_SECTIONS,
  DEFAULT_WORKSPACE_GROUPS,
  loadAgentModelSections,
  loadArchivedWorkspaces,
  loadSessionAttachments,
  loadSessionMessages,
  loadWorkspaceDetail,
  loadWorkspaceGroups,
  loadWorkspaceSessions,
  sendAgentMessage,
  type AgentModelOption,
  type AgentModelSection,
  type SessionAttachmentRecord,
  type SessionMessageRecord,
  type WorkspaceDetail,
  type WorkspaceGroup,
  type WorkspaceRow,
  type WorkspaceSessionSummary,
  type WorkspaceSummary,
} from "./lib/conductor";
import { WorkspacesSidebar } from "./components/workspaces-sidebar";
import { WorkspacePanel } from "./components/workspace-panel";
import { WorkspaceComposer } from "./components/workspace-composer";

const SIDEBAR_WIDTH_STORAGE_KEY = "helmor.workspaceSidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 16;
const SIDEBAR_RESIZE_HIT_AREA = 20;
const DEFAULT_CLAUDE_MODEL_ID = "opus-1m";
const DEFAULT_CODEX_MODEL_ID = "gpt-5.4";

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getInitialSidebarWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  try {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);

    if (!storedWidth) {
      return DEFAULT_SIDEBAR_WIDTH;
    }

    const parsedWidth = Number.parseInt(storedWidth, 10);

    return Number.isFinite(parsedWidth)
      ? clampSidebarWidth(parsedWidth)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function App() {
  const [sidebarWidth, setSidebarWidth] = useState(getInitialSidebarWidth);
  const [resizeState, setResizeState] = useState<{
    pointerX: number;
    sidebarWidth: number;
  } | null>(null);
  const [groups, setGroups] = useState<WorkspaceGroup[]>(DEFAULT_WORKSPACE_GROUPS);
  const [archivedSummaries, setArchivedSummaries] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    findInitialWorkspaceId(DEFAULT_WORKSPACE_GROUPS),
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceDetail | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionMessages, setSessionMessages] = useState<SessionMessageRecord[]>([]);
  const [sessionAttachments, setSessionAttachments] = useState<SessionAttachmentRecord[]>([]);
  const [agentModelSections, setAgentModelSections] = useState<AgentModelSection[]>(
    DEFAULT_AGENT_MODEL_SECTIONS,
  );
  const [composerValue, setComposerValue] = useState("");
  const [composerModelSelections, setComposerModelSelections] = useState<
    Record<string, string>
  >({});
  const [liveMessagesByContext, setLiveMessagesByContext] = useState<
    Record<string, SessionMessageRecord[]>
  >({});
  const [liveSessionsByContext, setLiveSessionsByContext] = useState<
    Record<string, { provider: string; sessionId?: string | null }>
  >({});
  const [sendErrorsByContext, setSendErrorsByContext] = useState<
    Record<string, string | null>
  >({});
  const [sendingContextKey, setSendingContextKey] = useState<string | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("helmor.theme") as "light" | "dark") ?? "dark";
  });
  const isResizing = resizeState !== null;

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("helmor.theme", next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const archivedRows = useMemo(
    () => archivedSummaries.map(summaryToArchivedRow),
    [archivedSummaries],
  );
  const selectedSession =
    workspaceSessions.find((session) => session.id === selectedSessionId) ?? null;
  const composerContextKey = getComposerContextKey(
    selectedWorkspaceId,
    selectedSessionId,
  );
  const selectedModelId =
    composerModelSelections[composerContextKey] ??
    inferDefaultModelId(selectedSession, agentModelSections);
  const selectedModel = findModelOption(agentModelSections, selectedModelId);
  const liveMessages = liveMessagesByContext[composerContextKey] ?? [];
  const mergedMessages = useMemo(
    () => [...sessionMessages, ...liveMessages],
    [sessionMessages, liveMessages],
  );
  const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
  const isSending = sendingContextKey === composerContextKey;

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(sidebarWidth),
      );
    } catch {
      // Ignore storage failures and keep the current in-memory width.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizeState) {
      return;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      setSidebarWidth(
        clampSidebarWidth(
          resizeState.sidebarWidth + event.clientX - resizeState.pointerX,
        ),
      );
    };
    const handleMouseUp = () => {
      setResizeState(null);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizeState]);

  useEffect(() => {
    let disposed = false;

    void Promise.all([
      loadWorkspaceGroups(),
      loadArchivedWorkspaces(),
      loadAgentModelSections(),
    ]).then(([loadedGroups, loadedArchived, loadedModelSections]) => {
        if (disposed) {
          return;
        }

        setGroups(loadedGroups);
        setArchivedSummaries(loadedArchived);
        setAgentModelSections(loadedModelSections);
        setSelectedWorkspaceId((current) => {
          if (current && hasWorkspaceId(current, loadedGroups, loadedArchived)) {
            return current;
          }

          return (
            findInitialWorkspaceId(loadedGroups) ??
            loadedArchived[0]?.id ??
            null
          );
        });
      },
    );

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setWorkspaceDetail(null);
      setWorkspaceSessions([]);
      setSelectedSessionId(null);
      return;
    }

    let disposed = false;
    setLoadingWorkspace(true);

    void Promise.all([
      loadWorkspaceDetail(selectedWorkspaceId),
      loadWorkspaceSessions(selectedWorkspaceId),
    ]).then(([detail, sessions]) => {
      if (disposed) {
        return;
      }

      setWorkspaceDetail(detail);
      setWorkspaceSessions(sessions);
      setSelectedSessionId((current) => {
        if (current && sessions.some((session) => session.id === current)) {
          return current;
        }

        return (
          detail?.activeSessionId ??
          sessions.find((session) => session.active)?.id ??
          sessions[0]?.id ??
          null
        );
      });
      setLoadingWorkspace(false);
    });

    return () => {
      disposed = true;
    };
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionMessages([]);
      setSessionAttachments([]);
      return;
    }

    let disposed = false;
    setLoadingSession(true);

    void Promise.all([
      loadSessionMessages(selectedSessionId),
      loadSessionAttachments(selectedSessionId),
    ]).then(([messages, attachments]) => {
      if (disposed) {
        return;
      }

      setSessionMessages(messages);
      setSessionAttachments(attachments);
      setLoadingSession(false);
    });

    return () => {
      disposed = true;
    };
  }, [selectedSessionId]);

  const handleResizeStart = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setResizeState({
      pointerX: event.clientX,
      sidebarWidth,
    });
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((currentWidth) =>
        clampSidebarWidth(currentWidth - SIDEBAR_RESIZE_STEP),
      );
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((currentWidth) =>
        clampSidebarWidth(currentWidth + SIDEBAR_RESIZE_STEP),
      );
    }
  };

  const handleComposerSubmit = async () => {
    const prompt = composerValue.trim();
    if (!prompt || !selectedModel) {
      return;
    }

    const contextKey = composerContextKey;
    const now = new Date().toISOString();
    const optimisticUserMessage = createLiveMessage({
      id: `${contextKey}:user:${Date.now()}`,
      sessionId: selectedSessionId ?? contextKey,
      role: "user",
      content: prompt,
      createdAt: now,
      model: selectedModel.id,
    });
    const previousLiveSession = liveSessionsByContext[contextKey];
    const sessionId =
      previousLiveSession?.provider === selectedModel.provider
        ? previousLiveSession.sessionId ?? undefined
        : undefined;

    setLiveMessagesByContext((current) =>
      appendLiveMessage(current, contextKey, optimisticUserMessage),
    );
    setComposerValue("");
    setSendErrorsByContext((current) => ({ ...current, [contextKey]: null }));
    setSendingContextKey(contextKey);

    try {
      const response = await sendAgentMessage({
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        prompt,
        sessionId,
        conductorSessionId: selectedSessionId,
        workingDirectory: workspaceDetail?.rootPath ?? null,
      });

      setLiveSessionsByContext((current) => ({
        ...current,
        [contextKey]: {
          provider: response.provider,
          sessionId: response.sessionId ?? current[contextKey]?.sessionId ?? null,
        },
      }));

      if (response.persistedToFixture && selectedSessionId) {
        const [messages, detail, sessions, loadedGroups, loadedArchived] =
          await Promise.all([
            loadSessionMessages(selectedSessionId),
            selectedWorkspaceId ? loadWorkspaceDetail(selectedWorkspaceId) : null,
            selectedWorkspaceId ? loadWorkspaceSessions(selectedWorkspaceId) : [],
            loadWorkspaceGroups(),
            loadArchivedWorkspaces(),
          ]);

        setSessionMessages(messages);
        if (selectedWorkspaceId) {
          setWorkspaceDetail(detail);
          setWorkspaceSessions(sessions);
        }
        setGroups(loadedGroups);
        setArchivedSummaries(loadedArchived);
        setLiveMessagesByContext((current) => ({
          ...current,
          [contextKey]: [],
        }));
      } else {
        setLiveMessagesByContext((current) =>
          appendLiveMessage(
            current,
            contextKey,
            createLiveMessage({
              id: `${contextKey}:assistant:${Date.now()}`,
              sessionId: selectedSessionId ?? contextKey,
              role: "assistant",
              content: response.assistantText,
              createdAt: new Date().toISOString(),
              model: response.resolvedModel,
            }),
          ),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to send message.";
      setSendErrorsByContext((current) => ({ ...current, [contextKey]: message }));
      setComposerValue(prompt);
      setLiveMessagesByContext((current) => ({
        ...current,
        [contextKey]: (current[contextKey] ?? []).filter(
          (message) => message.id !== optimisticUserMessage.id,
        ),
      }));
    } finally {
      setSendingContextKey((current) => (current === contextKey ? null : current));
    }
  };

  return (
    <main
      aria-label="Application shell"
      className="relative h-screen overflow-hidden bg-app-base font-sans text-app-foreground antialiased"
    >
      <div className="relative flex h-full min-h-0 bg-app-base">
        <aside
          aria-label="Workspace sidebar"
          className="relative h-full shrink-0 overflow-hidden bg-app-sidebar"
          style={{ width: `${sidebarWidth}px` }}
        >
          <WorkspacesSidebar
            groups={groups}
            archivedRows={archivedRows}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={(workspaceId) => {
              setSelectedWorkspaceId(workspaceId);
            }}
          />
        </aside>

        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          className="group absolute inset-y-0 z-30 cursor-ew-resize touch-none outline-none"
          style={{
            left: `${sidebarWidth - SIDEBAR_RESIZE_HIT_AREA / 2}px`,
            width: `${SIDEBAR_RESIZE_HIT_AREA}px`,
          }}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color,box-shadow] ${
              isResizing
                ? "w-[2px] bg-white shadow-[0_0_12px_rgba(255,255,255,0.38)]"
                : "w-px bg-app-border group-hover:w-[2px] group-hover:bg-app-foreground-soft/75 group-hover:shadow-[0_0_10px_rgba(255,255,255,0.14)] group-focus-visible:w-[2px] group-focus-visible:bg-app-foreground-soft/75"
            }`}
          />
        </div>

        <section
          aria-label="Workspace panel"
          className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-elevated"
        >
          <div
            aria-label="Workspace panel drag region"
            className="absolute inset-x-0 top-0 z-10 h-[2.4rem] bg-transparent"
            data-tauri-drag-region
          />

          <button
            type="button"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            className="absolute right-2.5 top-[0.45rem] z-30 flex size-6 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-toolbar-hover hover:text-app-foreground"
          >
            {theme === "dark" ? (
              <Sun className="size-3.5" strokeWidth={1.8} />
            ) : (
              <Moon className="size-3.5" strokeWidth={1.8} />
            )}
          </button>

          <div
            aria-label="Workspace viewport"
            className="flex min-h-0 flex-1 flex-col bg-app-elevated"
          >
            <WorkspacePanel
              workspace={workspaceDetail}
              sessions={workspaceSessions}
              selectedSessionId={selectedSessionId}
              messages={mergedMessages}
              attachments={sessionAttachments}
              loadingWorkspace={loadingWorkspace}
              loadingSession={loadingSession}
              onSelectSession={setSelectedSessionId}
            />

            <div className="mt-auto border-t border-app-border px-3 pb-3 pt-3">
              <WorkspaceComposer
                value={composerValue}
                onValueChange={setComposerValue}
                onSubmit={() => {
                  void handleComposerSubmit();
                }}
                sending={isSending}
                selectedModelId={selectedModelId}
                modelSections={agentModelSections}
                onSelectModel={(modelId) => {
                  setComposerModelSelections((current) => ({
                    ...current,
                    [composerContextKey]: modelId,
                  }));
                }}
                sendError={activeSendError}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function findInitialWorkspaceId(groups: WorkspaceGroup[]): string | null {
  for (const group of groups) {
    const activeRow = group.rows.find((row) => row.active);
    if (activeRow) {
      return activeRow.id;
    }
  }

  for (const group of groups) {
    if (group.rows.length > 0) {
      return group.rows[0].id;
    }
  }

  return null;
}

function hasWorkspaceId(
  workspaceId: string,
  groups: WorkspaceGroup[],
  archived: WorkspaceSummary[],
) {
  return (
    groups.some((group) => group.rows.some((row) => row.id === workspaceId)) ||
    archived.some((workspace) => workspace.id === workspaceId)
  );
}

function summaryToArchivedRow(summary: WorkspaceSummary): WorkspaceRow {
  return {
    id: summary.id,
    title: summary.title,
    active: false,
    directoryName: summary.directoryName,
    repoName: summary.repoName,
    repoIconSrc: summary.repoIconSrc ?? null,
    repoInitials: summary.repoInitials ?? null,
    state: summary.state,
    derivedStatus: summary.derivedStatus,
    manualStatus: summary.manualStatus ?? null,
    branch: summary.branch ?? null,
    activeSessionId: summary.activeSessionId ?? null,
    activeSessionTitle: summary.activeSessionTitle ?? null,
    activeSessionAgentType: summary.activeSessionAgentType ?? null,
    activeSessionStatus: summary.activeSessionStatus ?? null,
    prTitle: summary.prTitle ?? null,
    sessionCount: summary.sessionCount,
    messageCount: summary.messageCount,
    attachmentCount: summary.attachmentCount,
  };
}

function getComposerContextKey(
  workspaceId: string | null,
  sessionId: string | null,
): string {
  if (sessionId) {
    return `session:${sessionId}`;
  }

  if (workspaceId) {
    return `workspace:${workspaceId}`;
  }

  return "global";
}

function inferDefaultModelId(
  session: WorkspaceSessionSummary | null,
  modelSections: AgentModelSection[],
): string {
  const preferredModelId = session?.model ?? null;
  if (preferredModelId && findModelOption(modelSections, preferredModelId)) {
    return preferredModelId;
  }

  return session?.agentType === "codex"
    ? DEFAULT_CODEX_MODEL_ID
    : DEFAULT_CLAUDE_MODEL_ID;
}

function findModelOption(
  modelSections: AgentModelSection[],
  modelId: string | null,
): AgentModelOption | null {
  if (!modelId) {
    return null;
  }

  return (
    modelSections
      .flatMap((section) => section.options)
      .find((option) => option.id === modelId) ?? null
  );
}

function createLiveMessage({
  id,
  sessionId,
  role,
  content,
  createdAt,
  model,
}: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  model: string;
}): SessionMessageRecord {
  return {
    id,
    sessionId,
    role,
    content,
    contentIsJson: false,
    createdAt,
    sentAt: createdAt,
    cancelledAt: null,
    model,
    sdkMessageId: null,
    lastAssistantMessageId: null,
    turnId: null,
    isResumableMessage: null,
    attachmentCount: 0,
  };
}

function appendLiveMessage(
  current: Record<string, SessionMessageRecord[]>,
  contextKey: string,
  message: SessionMessageRecord,
) {
  return {
    ...current,
    [contextKey]: [...(current[contextKey] ?? []), message],
  };
}

export default App;
