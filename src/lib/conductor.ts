import { invoke } from "@tauri-apps/api/core";

export type GroupTone = "done" | "review" | "progress" | "backlog" | "canceled";

export type WorkspaceRow = {
  id: string;
  title: string;
  avatar?: string;
  active?: boolean;
  directoryName?: string;
  repoName?: string;
  repoIconSrc?: string | null;
  repoInitials?: string | null;
  state?: string;
  derivedStatus?: string;
  manualStatus?: string | null;
  branch?: string | null;
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  activeSessionAgentType?: string | null;
  activeSessionStatus?: string | null;
  prTitle?: string | null;
  sessionCount?: number;
  messageCount?: number;
  attachmentCount?: number;
};

export type WorkspaceGroup = {
  id: string;
  label: string;
  tone: GroupTone;
  rows: WorkspaceRow[];
};

export type ConductorFixtureInfo = {
  dataMode: string;
  fixtureRoot: string;
  dbPath: string;
  archiveRoot: string;
};

export type AgentProvider = "claude" | "codex";

export type AgentModelOption = {
  id: string;
  provider: AgentProvider;
  label: string;
  cliModel: string;
  badge?: string | null;
};

export type AgentModelSection = {
  id: AgentProvider;
  label: string;
  options: AgentModelOption[];
};

export type AgentSendRequest = {
  provider: AgentProvider;
  modelId: string;
  prompt: string;
  sessionId?: string | null;
  conductorSessionId?: string | null;
  workingDirectory?: string | null;
};

export type AgentSendResponse = {
  provider: AgentProvider;
  modelId: string;
  resolvedModel: string;
  sessionId?: string | null;
  assistantText: string;
  workingDirectory: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  persistedToFixture: boolean;
};

export type WorkspaceSummary = {
  id: string;
  title: string;
  directoryName: string;
  repoName: string;
  repoIconSrc?: string | null;
  repoInitials?: string | null;
  state: string;
  derivedStatus: string;
  manualStatus?: string | null;
  active: boolean;
  branch?: string | null;
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  activeSessionAgentType?: string | null;
  activeSessionStatus?: string | null;
  prTitle?: string | null;
  sessionCount?: number;
  messageCount?: number;
  attachmentCount?: number;
};

export type WorkspaceDetail = {
  id: string;
  title: string;
  repoId: string;
  repoName: string;
  repoIconSrc?: string | null;
  repoInitials?: string | null;
  remoteUrl?: string | null;
  defaultBranch?: string | null;
  rootPath?: string | null;
  directoryName: string;
  state: string;
  derivedStatus: string;
  manualStatus?: string | null;
  active: boolean;
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  activeSessionAgentType?: string | null;
  activeSessionStatus?: string | null;
  branch?: string | null;
  initializationParentBranch?: string | null;
  intendedTargetBranch?: string | null;
  notes?: string | null;
  pinnedAt?: string | null;
  prTitle?: string | null;
  prDescription?: string | null;
  archiveCommit?: string | null;
  sessionCount: number;
  messageCount: number;
  attachmentCount: number;
};

export type WorkspaceSessionSummary = {
  id: string;
  workspaceId: string;
  title: string;
  agentType?: string | null;
  status: string;
  model?: string | null;
  permissionMode: string;
  claudeSessionId?: string | null;
  unreadCount: number;
  contextTokenCount: number;
  contextUsedPercent?: number | null;
  thinkingEnabled: boolean;
  codexThinkingLevel?: string | null;
  fastMode: boolean;
  agentPersonality?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt?: string | null;
  resumeSessionAt?: string | null;
  isHidden: boolean;
  isCompacting: boolean;
  active: boolean;
};

export type SessionMessageRecord = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  contentIsJson: boolean;
  parsedContent?: unknown;
  createdAt: string;
  sentAt?: string | null;
  cancelledAt?: string | null;
  model?: string | null;
  sdkMessageId?: string | null;
  lastAssistantMessageId?: string | null;
  turnId?: string | null;
  isResumableMessage?: boolean | null;
  attachmentCount: number;
};

export type SessionAttachmentRecord = {
  id: string;
  sessionId: string;
  sessionMessageId?: string | null;
  attachmentType?: string | null;
  originalName?: string | null;
  path?: string | null;
  pathExists: boolean;
  isLoading: boolean;
  isDraft: boolean;
  createdAt: string;
};

const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
  {
    id: "done",
    label: "Done",
    tone: "done",
    rows: [
      {
        id: "task-detail",
        title: "feat: task detail window with e...",
        repoInitials: "F",
      },
    ],
  },
  {
    id: "review",
    label: "In review",
    tone: "review",
    rows: [
      {
        id: "coda-publish",
        title: "feat: add Coda publish function...",
        repoInitials: "F",
      },
      {
        id: "marketing-site",
        title: "Implement new marketing site ...",
        repoInitials: "I",
      },
      {
        id: "gitlab-publish",
        title: "feat: add GitLab publish suppor...",
        repoInitials: "F",
      },
    ],
  },
  {
    id: "progress",
    label: "In progress",
    tone: "progress",
    rows: [
      {
        id: "cambridge",
        title: "Cambridge",
        repoInitials: "C",
      },
      {
        id: "project-paths",
        title: "Show project paths",
        repoInitials: "S",
        active: true,
      },
      {
        id: "mermaid",
        title: "Investigate mermaid confluence",
        repoInitials: "I",
      },
      {
        id: "seo",
        title: "Feat seo optimization",
        repoInitials: "F",
      },
      {
        id: "autoresearch",
        title: "Explore autoresearch",
        repoInitials: "E",
      },
      {
        id: "chat-list",
        title: "Fix chat list pending",
        repoInitials: "F",
      },
      {
        id: "doc-sync",
        title: "Investigate doc sync",
        repoInitials: "I",
      },
    ],
  },
  {
    id: "backlog",
    label: "Backlog",
    tone: "backlog",
    rows: [],
  },
  {
    id: "canceled",
    label: "Canceled",
    tone: "canceled",
    rows: [],
  },
];

const DEFAULT_ARCHIVED_WORKSPACES: WorkspaceSummary[] = [
  {
    id: "archived-coda-publish",
    title: "feat: add Coda publish function...",
    directoryName: "coda-publish",
    repoName: "sample",
    state: "archived",
    derivedStatus: "done",
    active: false,
  },
  {
    id: "archived-marketing-site",
    title: "Implement new marketing site ...",
    directoryName: "marketing-site",
    repoName: "sample",
    state: "archived",
    derivedStatus: "review",
    active: false,
  },
  {
    id: "archived-gitlab-publish",
    title: "feat: add GitLab publish suppor...",
    directoryName: "gitlab-publish",
    repoName: "sample",
    state: "archived",
    derivedStatus: "review",
    active: false,
  },
];

const DEFAULT_AGENT_MODEL_SECTIONS: AgentModelSection[] = [
  {
    id: "claude",
    label: "Claude Code",
    options: [
      {
        id: "opus-1m",
        provider: "claude",
        label: "Opus 4.6 1M",
        cliModel: "opus[1m]",
        badge: "NEW",
      },
      {
        id: "opus",
        provider: "claude",
        label: "Opus 4.6",
        cliModel: "opus",
      },
      {
        id: "sonnet",
        provider: "claude",
        label: "Sonnet 4.6",
        cliModel: "sonnet",
      },
      {
        id: "haiku",
        provider: "claude",
        label: "Haiku 4.5",
        cliModel: "haiku",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    options: [
      {
        id: "gpt-5.4",
        provider: "codex",
        label: "GPT-5.4",
        cliModel: "gpt-5.4",
        badge: "NEW",
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "codex",
        label: "GPT-5.3-Codex-Spark",
        cliModel: "gpt-5.3-codex-spark",
      },
      {
        id: "gpt-5.3-codex",
        provider: "codex",
        label: "GPT-5.3-Codex",
        cliModel: "gpt-5.3-codex",
      },
      {
        id: "gpt-5.2-codex",
        provider: "codex",
        label: "GPT-5.2-Codex",
        cliModel: "gpt-5.2-codex",
      },
    ],
  },
];

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function getTauriInvoke(): Promise<TauriInvoke | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null;
  }

  return invoke as TauriInvoke;
}

export async function loadWorkspaceGroups(): Promise<WorkspaceGroup[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return DEFAULT_WORKSPACE_GROUPS;
  }

  try {
    return await invoke<WorkspaceGroup[]>("list_workspace_groups");
  } catch {
    return DEFAULT_WORKSPACE_GROUPS;
  }
}

export async function loadFixtureInfo(): Promise<ConductorFixtureInfo | null> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return null;
  }

  try {
    return await invoke<ConductorFixtureInfo>("get_conductor_fixture_info");
  } catch {
    return null;
  }
}

export async function loadArchivedWorkspaces(): Promise<WorkspaceSummary[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return DEFAULT_ARCHIVED_WORKSPACES;
  }

  try {
    return await invoke<WorkspaceSummary[]>("list_archived_workspaces");
  } catch {
    return DEFAULT_ARCHIVED_WORKSPACES;
  }
}

export async function loadAgentModelSections(): Promise<AgentModelSection[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return DEFAULT_AGENT_MODEL_SECTIONS;
  }

  try {
    return await invoke<AgentModelSection[]>("list_agent_model_sections");
  } catch {
    return DEFAULT_AGENT_MODEL_SECTIONS;
  }
}

export async function loadWorkspaceDetail(
  workspaceId: string,
): Promise<WorkspaceDetail | null> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return null;
  }

  try {
    return await invoke<WorkspaceDetail>("get_workspace", { workspaceId });
  } catch {
    return null;
  }
}

export async function loadWorkspaceSessions(
  workspaceId: string,
): Promise<WorkspaceSessionSummary[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return [];
  }

  try {
    return await invoke<WorkspaceSessionSummary[]>("list_workspace_sessions", {
      workspaceId,
    });
  } catch {
    return [];
  }
}

export async function loadSessionMessages(
  sessionId: string,
): Promise<SessionMessageRecord[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return [];
  }

  try {
    return await invoke<SessionMessageRecord[]>("list_session_messages", {
      sessionId,
    });
  } catch {
    return [];
  }
}

export async function loadSessionAttachments(
  sessionId: string,
): Promise<SessionAttachmentRecord[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return [];
  }

  try {
    return await invoke<SessionAttachmentRecord[]>("list_session_attachments", {
      sessionId,
    });
  } catch {
    return [];
  }
}

export async function sendAgentMessage(
  request: AgentSendRequest,
): Promise<AgentSendResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return {
      provider: request.provider,
      modelId: request.modelId,
      resolvedModel: request.modelId,
      sessionId: request.sessionId ?? null,
      assistantText:
        "Live agent sending is only available in the Tauri desktop runtime.",
      workingDirectory: request.workingDirectory ?? "",
      inputTokens: null,
      outputTokens: null,
      persistedToFixture: false,
    };
  }

  return invoke<AgentSendResponse>("send_agent_message", { request });
}

export { DEFAULT_AGENT_MODEL_SECTIONS, DEFAULT_WORKSPACE_GROUPS };
