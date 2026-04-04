import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  Download,
  GitBranch,
  Loader2,
  Search,
} from "lucide-react";
import {
  type ConductorRepo,
  type ConductorWorkspace,
  importConductorWorkspaces,
  listConductorRepos,
  listConductorWorkspaces,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanize(directoryName: string): string {
  return directoryName
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusLabel(ws: ConductorWorkspace): string {
  if (ws.state === "archived") return "Archived";
  if (ws.derivedStatus === "done") return "Done";
  if (ws.derivedStatus === "in-progress") return "In progress";
  return ws.derivedStatus ?? ws.state;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConductorImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // --- data state ---
  const [repos, setRepos] = useState<ConductorRepo[]>([]);
  const [workspaces, setWorkspaces] = useState<ConductorWorkspace[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- ui state ---
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // --- load repos when dialog opens ---
  useEffect(() => {
    if (!open) return;
    setSelectedRepoId(null);
    setWorkspaces([]);
    setSelectedIds(new Set());
    setSearchQuery("");
    setLoading(true);
    listConductorRepos()
      .then(setRepos)
      .catch(() => setRepos([]))
      .finally(() => setLoading(false));
  }, [open]);

  // --- load workspaces when repo selected ---
  useEffect(() => {
    if (!selectedRepoId) return;
    setSearchQuery("");
    setLoading(true);
    listConductorWorkspaces(selectedRepoId)
      .then((ws) => {
        setWorkspaces(ws);
        // Pre-select all importable workspaces
        const importable = ws.filter((w) => !w.alreadyImported).map((w) => w.id);
        setSelectedIds(new Set(importable));
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoading(false));
  }, [selectedRepoId]);

  // --- focus search on step change ---
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, selectedRepoId]);

  // --- close on escape / click outside ---
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedRepoId) {
          setSelectedRepoId(null);
        } else {
          onClose();
        }
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !panelRef.current?.contains(e.target)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, selectedRepoId, onClose]);

  // --- filtered repos ---
  const filteredRepos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.name.toLowerCase().includes(q));
  }, [repos, searchQuery]);

  // --- filtered workspaces ---
  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => {
      const haystack = `${w.directoryName} ${w.branch ?? ""} ${w.prTitle ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [workspaces, searchQuery]);

  // --- selection helpers ---
  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const importableWorkspaces = useMemo(
    () => workspaces.filter((w) => !w.alreadyImported),
    [workspaces],
  );

  const toggleAll = useCallback(() => {
    if (selectedIds.size === importableWorkspaces.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(importableWorkspaces.map((w) => w.id)));
    }
  }, [selectedIds.size, importableWorkspaces]);

  const [importError, setImportError] = useState<string | null>(null);

  // --- import handler ---
  const handleImport = useCallback(async () => {
    if (importing || selectedIds.size === 0) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importConductorWorkspaces(Array.from(selectedIds));
      if (result.importedCount > 0) {
        onImported();
        onClose();
      } else if (result.errors.length > 0) {
        setImportError(result.errors[0]);
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }, [importing, selectedIds, onImported, onClose]);

  if (!open) return null;

  const selectedRepoName = repos.find((r) => r.id === selectedRepoId)?.name;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Import from Conductor"
        className="relative z-10 flex w-[24rem] flex-col rounded-[14px] border border-app-border bg-app-sidebar shadow-[0_18px_48px_rgba(0,0,0,0.38)]"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          {selectedRepoId ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-app-foreground-soft transition-colors hover:text-app-foreground"
              onClick={() => setSelectedRepoId(null)}
            >
              <ArrowLeft className="size-3.5" strokeWidth={2} />
            </button>
          ) : (
            <Download className="size-3.5 text-app-foreground-soft" strokeWidth={1.8} />
          )}
          <h2 className="text-[13px] font-medium tracking-[-0.01em] text-app-foreground">
            {selectedRepoId ? selectedRepoName : "Import from Conductor"}
          </h2>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-app-foreground-soft/60"
              strokeWidth={1.9}
            />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              placeholder={selectedRepoId ? "Search workspaces" : "Search repositories"}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-9 w-full rounded-full border border-app-border bg-app-toolbar px-9 text-[13px] font-medium text-app-foreground outline-none placeholder:text-app-foreground-soft/56 focus:border-app-border-strong"
            />
          </div>
        </div>

        {/* Content */}
        <div className="max-h-80 min-h-[6rem] overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-app-foreground-soft" />
            </div>
          ) : selectedRepoId ? (
            // --- Workspace list ---
            <>
              {importableWorkspaces.length > 1 && (
                <button
                  type="button"
                  className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] uppercase tracking-[0.14em] text-app-foreground-soft/70 transition-colors hover:text-app-foreground-soft"
                  onClick={toggleAll}
                >
                  {selectedIds.size === importableWorkspaces.length
                    ? "Deselect all"
                    : "Select all"}
                </button>
              )}
              {filteredWorkspaces.length > 0 ? (
                filteredWorkspaces.map((ws) => (
                  <WorkspaceRow
                    key={ws.id}
                    workspace={ws}
                    checked={selectedIds.has(ws.id)}
                    onToggle={toggleId}
                  />
                ))
              ) : (
                <p className="py-6 text-center text-[13px] text-app-foreground-soft/60">
                  No workspaces found
                </p>
              )}
            </>
          ) : (
            // --- Repo list ---
            <>
              {filteredRepos.length > 0 ? (
                filteredRepos.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    onClick={() => setSelectedRepoId(repo.id)}
                  />
                ))
              ) : (
                <p className="py-6 text-center text-[13px] text-app-foreground-soft/60">
                  {repos.length === 0 ? "No Conductor repositories found" : "No matches"}
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer — only in workspace step */}
        {selectedRepoId && !loading && (
          <div className="border-t border-app-border px-4 py-3">
            {importError && (
              <p className="mb-2 truncate text-[11px] text-red-400" title={importError}>
                {importError}
              </p>
            )}
            <button
              type="button"
              disabled={selectedIds.size === 0 || importing}
              onClick={handleImport}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-full bg-app-elevated text-[13px] font-medium text-app-foreground transition-colors hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
            >
              {importing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" strokeWidth={1.8} />
              )}
              {importing
                ? "Importing..."
                : `Import ${selectedIds.size} workspace${selectedIds.size === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RepoRow({
  repo,
  onClick,
}: {
  repo: ConductorRepo;
  onClick: () => void;
}) {
  const allImported = repo.workspaceCount > 0 && repo.alreadyImportedCount >= repo.workspaceCount;

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors ${
        allImported
          ? "opacity-40"
          : "hover:bg-app-row-hover"
      }`}
      onClick={onClick}
    >
      {/* Initials avatar */}
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-app-elevated text-[11px] font-semibold uppercase text-app-foreground-soft">
        {repo.name.slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-app-foreground">
          {repo.name}
        </span>
        <span className="block text-[11px] tracking-[0.04em] text-app-foreground-soft/52">
          {allImported
            ? "All imported"
            : repo.alreadyImportedCount > 0
              ? `${repo.alreadyImportedCount}/${repo.workspaceCount} imported`
              : `${repo.workspaceCount} workspace${repo.workspaceCount === 1 ? "" : "s"}`}
        </span>
      </div>
    </button>
  );
}

function WorkspaceRow({
  workspace,
  checked,
  onToggle,
}: {
  workspace: ConductorWorkspace;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  if (workspace.alreadyImported) {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 opacity-40">
        <div className="flex size-4 shrink-0 items-center justify-center rounded border border-app-border-strong text-app-foreground-soft">
          <Check className="size-3" strokeWidth={2.5} />
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-app-foreground-soft">
            {workspace.prTitle || humanize(workspace.directoryName)}
          </span>
          <span className="block text-[11px] tracking-[0.04em] text-app-foreground-soft/52">
            Already imported
          </span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-app-row-hover"
      onClick={() => onToggle(workspace.id)}
    >
      {/* Checkbox */}
      <div
        className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked
            ? "border-app-foreground-soft bg-app-foreground-soft text-app-base"
            : "border-app-border-strong"
        }`}
      >
        {checked && <Check className="size-3" strokeWidth={2.5} />}
      </div>

      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-app-foreground">
          {workspace.prTitle || humanize(workspace.directoryName)}
        </span>
        <div className="flex items-center gap-2 text-[11px] tracking-[0.04em] text-app-foreground-soft/52">
          {workspace.branch && (
            <span className="flex items-center gap-0.5 truncate">
              <GitBranch className="size-2.5 shrink-0" strokeWidth={2} />
              {workspace.branch}
            </span>
          )}
          <span>{statusLabel(workspace)}</span>
          <span>
            {workspace.sessionCount} session{workspace.sessionCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </button>
  );
}
