import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type GroupTone = "done" | "review" | "progress" | "backlog" | "canceled";

export type WorkspaceRow = {
  id: string;
  title: string;
  avatar?: string;
  directoryName?: string;
  repoName?: string;
  repoIconSrc?: string | null;
  repoInitials?: string | null;
  state?: string;
  hasUnread?: boolean;
  workspaceUnread?: number;
  sessionUnreadTotal?: number;
  unreadSessionCount?: number;
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

export type DataInfo = {
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
  thinkingText?: string | null;
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
  hasUnread: boolean;
  workspaceUnread: number;
  sessionUnreadTotal: number;
  unreadSessionCount: number;
  derivedStatus: string;
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

export type RepositoryCreateOption = {
  id: string;
  name: string;
  defaultBranch?: string | null;
  repoIconSrc?: string | null;
  repoInitials?: string | null;
};

export type AddRepositoryDefaults = {
  lastCloneDirectory?: string | null;
};

export type AddRepositoryResponse = {
  repositoryId: string;
  createdRepository: boolean;
  selectedWorkspaceId: string;
  createdWorkspaceId?: string | null;
  createdWorkspaceState: string;
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
  hasUnread: boolean;
  workspaceUnread: number;
  sessionUnreadTotal: number;
  unreadSessionCount: number;
  derivedStatus: string;
  manualStatus?: string | null;
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

export type RestoreWorkspaceResponse = {
  restoredWorkspaceId: string;
  restoredState: string;
  selectedWorkspaceId: string;
};

export type ArchiveWorkspaceResponse = {
  archivedWorkspaceId: string;
  archivedState: string;
};

export type CreateWorkspaceResponse = {
  createdWorkspaceId: string;
  selectedWorkspaceId: string;
  createdState: string;
  directoryName: string;
  branch: string;
};

export type MarkWorkspaceReadResponse = void;

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
        hasUnread: true,
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

const DEFAULT_REPOSITORIES: RepositoryCreateOption[] = [];
const DEFAULT_ADD_REPOSITORY_DEFAULTS: AddRepositoryDefaults = {
  lastCloneDirectory: null,
};

const DEFAULT_ARCHIVED_WORKSPACES: WorkspaceSummary[] = [
  {
    id: "archived-coda-publish",
    title: "feat: add Coda publish function...",
    directoryName: "coda-publish",
    repoName: "sample",
    state: "archived",
    hasUnread: false,
    workspaceUnread: 0,
    sessionUnreadTotal: 0,
    unreadSessionCount: 0,
    derivedStatus: "done",
  },
  {
    id: "archived-marketing-site",
    title: "Implement new marketing site ...",
    directoryName: "marketing-site",
    repoName: "sample",
    state: "archived",
    hasUnread: false,
    workspaceUnread: 0,
    sessionUnreadTotal: 0,
    unreadSessionCount: 0,
    derivedStatus: "review",
  },
  {
    id: "archived-gitlab-publish",
    title: "feat: add GitLab publish suppor...",
    directoryName: "gitlab-publish",
    repoName: "sample",
    state: "archived",
    hasUnread: false,
    workspaceUnread: 0,
    sessionUnreadTotal: 0,
    unreadSessionCount: 0,
    derivedStatus: "review",
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

export async function loadDataInfo(): Promise<DataInfo | null> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return null;
  }

  try {
    return await invoke<DataInfo>("get_data_info");
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

export async function listRepositories(): Promise<RepositoryCreateOption[]> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return DEFAULT_REPOSITORIES;
  }

  try {
    return await invoke<RepositoryCreateOption[]>("list_repositories");
  } catch {
    return DEFAULT_REPOSITORIES;
  }
}

export async function loadAddRepositoryDefaults(): Promise<AddRepositoryDefaults> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    return DEFAULT_ADD_REPOSITORY_DEFAULTS;
  }

  try {
    return await invoke<AddRepositoryDefaults>("get_add_repository_defaults");
  } catch {
    return DEFAULT_ADD_REPOSITORY_DEFAULTS;
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

export async function restoreWorkspace(
  workspaceId: string,
): Promise<RestoreWorkspaceResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Workspace restore is only available in the Tauri desktop runtime.");
  }

  return invoke<RestoreWorkspaceResponse>("restore_workspace", {
    workspaceId,
  });
}

export async function archiveWorkspace(
  workspaceId: string,
): Promise<ArchiveWorkspaceResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Workspace archive is only available in the Tauri desktop runtime.");
  }

  return invoke<ArchiveWorkspaceResponse>("archive_workspace", {
    workspaceId,
  });
}

export async function createWorkspaceFromRepo(
  repoId: string,
): Promise<CreateWorkspaceResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Workspace creation is only available in the Tauri desktop runtime.");
  }

  return invoke<CreateWorkspaceResponse>("create_workspace_from_repo", {
    repoId,
  });
}

export async function addRepositoryFromLocalPath(
  folderPath: string,
): Promise<AddRepositoryResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Repository add is only available in the Tauri desktop runtime.");
  }

  return invoke<AddRepositoryResponse>("add_repository_from_local_path", {
    folderPath,
  });
}

export async function markSessionRead(sessionId: string): Promise<MarkWorkspaceReadResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Session read tracking is only available in the Tauri desktop runtime.");
  }

  return invoke<MarkWorkspaceReadResponse>("mark_session_read", {
    sessionId,
  });
}

export async function markWorkspaceRead(workspaceId: string): Promise<MarkWorkspaceReadResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Workspace read tracking is only available in the Tauri desktop runtime.");
  }

  return invoke<MarkWorkspaceReadResponse>("mark_workspace_read", {
    workspaceId,
  });
}

export async function markWorkspaceUnread(
  workspaceId: string,
): Promise<MarkWorkspaceReadResponse> {
  const invoke = await getTauriInvoke();

  if (!invoke) {
    throw new Error("Workspace unread tracking is only available in the Tauri desktop runtime.");
  }

  return invoke<MarkWorkspaceReadResponse>("mark_workspace_unread", {
    workspaceId,
  });
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
      thinkingText: null,
      workingDirectory: request.workingDirectory ?? "",
      inputTokens: null,
      outputTokens: null,
      persistedToFixture: false,
    };
  }

  return invoke<AgentSendResponse>("send_agent_message", { request });
}

// ---------------------------------------------------------------------------
// Streaming agent API
// ---------------------------------------------------------------------------

export type AgentStreamStartResponse = {
  streamId: string;
};

export type AgentStreamEvent =
  | { kind: "line"; line: string }
  | {
      kind: "done";
      provider: AgentProvider;
      modelId: string;
      resolvedModel: string;
      sessionId?: string | null;
      workingDirectory: string;
      persistedToFixture: boolean;
    }
  | { kind: "error"; message: string };

export async function startAgentMessageStream(
  request: AgentSendRequest,
): Promise<AgentStreamStartResponse> {
  const inv = await getTauriInvoke();
  if (!inv) {
    throw new Error("Streaming is only available in the Tauri desktop runtime.");
  }
  return inv<AgentStreamStartResponse>("send_agent_message_stream", { request });
}

export async function listenAgentStream(
  streamId: string,
  callback: (event: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentStreamEvent>(`agent-stream:${streamId}`, (tauriEvent) => {
    callback(tauriEvent.payload);
  });
}

export { DEFAULT_AGENT_MODEL_SECTIONS, DEFAULT_WORKSPACE_GROUPS };
