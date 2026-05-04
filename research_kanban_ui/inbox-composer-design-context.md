# Inbox + Composer Overlay — Designer Context Doc

This document gives a **designer agent** all the OBJECTIVE context needed to design two new UI surfaces in Helmor:

1. **Inbox sidebar** — replaces the workspace navigation when kanban mode is active
2. **Composer overlay flow** — the floating composer triggered by dragging an inbox card onto certain kanban columns

It does NOT prescribe colors, spacing, typography, sizing, or specific Tailwind classes. Those are for the designer to decide based on the existing Helmor visual system and their own taste. This doc only tells you **what data is available, what behavior is locked, and what existing pieces to plug into**.

---

## 0. Project background (one paragraph)

Helmor is a local-first desktop app (Tauri v2 + React 19 + Vite + TypeScript) that lets users manage workspaces and dispatch agents (Claude Code CLI / OpenAI Codex CLI) over their codebases. The kanban view shows Helmor workspaces as cards across status columns (Backlog → In Progress → ...). We are now extending the kanban into a triage surface: external context sources (Linear issues, GitHub Issues/PRs/Discussions, Slack threads) appear in a new left-sidebar **Inbox**, and the user drags them into kanban columns to spawn workspaces from those contexts. The composer pops as a floating overlay pre-filled with the dragged card.

---

## 1. Locked behavior contracts

These have all been agreed on in product discussion and are NOT up for redesign.

### 1.1 Inbox sidebar

| Aspect | Locked behavior |
|---|---|
| Visibility | Only when kanban mode is active. **Replaces** the workspace nav (互斥, never coexists). Triggered by the kanban shortcut. |
| Width | Replaces the existing left sidebar 1:1 (same width). |
| Top region | **Source filter** — icon tiles, single-select. One source visible at a time. (Sources: Linear / GitHub / Slack / ... — extensible.) |
| Card list | Vertical scrollable list of `ContextCard`s filtered by selected source. |
| Card interactions | Cards are **draggable** (DnD source). They are NEVER drop targets. Click navigation is TBD by designer. |
| Empty state | TBD by designer. |

### 1.2 Composer overlay

| Aspect | Locked behavior |
|---|---|
| Trigger | A source card is dropped on **Backlog** OR **In Progress** kanban column. Drops on other columns are rejected — composer does not open. |
| Surface | Floating overlay on top of kanban (modal-like). |
| Initial content | Dropped source card pre-attached as a context chip. Composer text empty. Repo not selected. |
| Repo picker | Required dropdown to the LEFT of the send button. |
| Send button text | `Save to Backlog` if drop target was Backlog. `Send` if In Progress. (Two distinct labels — prevents accidental agent runs.) |
| Adding more context | User can drag MORE inbox cards into the open composer overlay. Each becomes another chip. |
| Cancel (Esc / X) | NO workspace is created. NO data persisted. Pure cancel. |
| Reusing existing composer | The new overlay is a wrapper around the existing composer at `src/features/composer/`. Do not re-implement the editor — wrap it. The chip UX should mirror the existing `/add-dir` add-to-composer pattern. |

### 1.3 Source card "transformed" state

| Aspect | Locked behavior |
|---|---|
| Trigger | A source card is included in ANY workspace (whether as the initial drop trigger OR as additional context dragged into composer). |
| Visual | Gray / translucent state — designer decides exact treatment. |
| Functional impact | **NONE.** Card remains fully usable: still draggable, still attachable as context to new workspaces. The gray is a status marker only. |

### 1.4 Backlog "prepared" indicator

| Aspect | Locked behavior |
|---|---|
| Trigger | A workspace card in the Backlog column has `draftMessage != null`. |
| Visual | Small indicator on the workspace card hinting "prepared draft exists". Designer's call. |
| Effect when opened | Composer auto-fills from `draftMessage` (text + context chips). |

### 1.5 Drop matrix (kanban columns)

| Drop source | Backlog | In Progress | Done / Other |
|---|---|---|---|
| Inbox source card | Composer opens (`Save to Backlog`) | Composer opens (`Send`) | Rejected |
| Workspace card (existing kanban) | Status change (existing behavior) | Status change | Status change |

Workspace cards never trigger the composer overlay.

---

## 2. The unified `ContextCard` data shape

All inbox cards share ONE TypeScript interface. The designer should design ONE card component shape that adapts via source-specific accents (icon, identifier format, badge tone) — NOT separate components per source.

```ts
type ContextCardSource =
  | 'linear'
  | 'github_issue'
  | 'github_pr'
  | 'github_discussion'
  | 'slack_thread';

type ContextCardStateTone =
  | 'open'         // GH issue open, Linear started
  | 'closed'       // GH issue/PR closed (not merged)
  | 'merged'       // GH PR merged
  | 'draft'        // GH PR draft
  | 'answered'     // GH discussion answered
  | 'unanswered'
  | 'urgent'       // Linear P1
  | 'neutral';

type ContextCard = {
  // Identity
  id: string;                          // app-internal, globally unique across sources
  source: ContextCardSource;
  externalId: string;                  // source-side: 'ABC-123', 'owner/repo#456', 'C012/123.45'
  externalUrl: string;                 // permalink (open in source app)

  // Display essentials — these are what the card face shows
  title: string;
  subtitle?: string;                   // repo / project / channel
  state?: { label: string; tone: ContextCardStateTone };
  lastActivityAt: number;              // unix ms — display as "2h ago" etc.

  // Lifecycle
  transformedWorkspaceIds: string[];   // non-empty = card is in transformed (gray) state

  // Source-specific extras — designer's discretion (hover popover / expand / hide)
  meta: ContextCardMeta;
};

type ContextCardMeta =
  | LinearIssueMeta
  | GitHubIssueMeta
  | GitHubPRMeta
  | GitHubDiscussionMeta
  | SlackThreadMeta;
```

---

## 3. Source-specific raw schemas (representative)

> **Note**: V1 will use mock data. The schemas below are based on standard public APIs (Linear GraphQL, GitHub REST/GraphQL, Slack Web API) and are **representative** — exact field names may shift after the API research pass. The designer should treat these as a guide for which info is realistically available per source, NOT contracts.

### 3.1 Linear Issue

```ts
type LinearIssueMeta = {
  type: 'linear';
  identifier: string;                  // "ABC-123"
  number: number;                      // 123
  state: {
    name: string;                      // "In Progress", "Backlog", "Done"
    type: 'backlog'|'unstarted'|'started'|'completed'|'canceled';
    color: string;                     // hex from Linear
  };
  priority: 0|1|2|3|4;                 // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  priorityLabel: string;
  assignee?: { name: string; avatarUrl: string };
  team: { name: string; key: string };  // key e.g. "ENG"
  project?: { name: string; color: string };
  labels: { name: string; color: string }[];
  description?: string;
};
```

### 3.2 GitHub Issue

```ts
type GitHubIssueMeta = {
  type: 'github_issue';
  repo: string;                        // "owner/name"
  number: number;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | 'reopened';
  author: { login: string; avatarUrl: string };
  assignees: { login: string; avatarUrl: string }[];
  labels: { name: string; color: string }[];   // color is 6-char hex from GitHub
  commentCount: number;
  body?: string;
};
```

### 3.3 GitHub Pull Request

```ts
type GitHubPRMeta = {
  type: 'github_pr';
  repo: string;
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author: { login: string; avatarUrl: string };
  assignees: { login: string; avatarUrl: string }[];
  reviewers: { login: string; avatarUrl: string }[];
  labels: { name: string; color: string }[];
  headBranch: string;                  // source branch
  baseBranch: string;                  // target branch (usually 'main')
  additions: number;
  deletions: number;
  changedFiles: number;
  commentCount: number;
  reviewCommentCount: number;
  ciStatus?: 'success' | 'failure' | 'pending' | 'neutral';
  body?: string;
};
```

### 3.4 GitHub Discussion

```ts
type GitHubDiscussionMeta = {
  type: 'github_discussion';
  repo: string;
  number: number;
  category: { name: string; emoji: string };   // e.g. { name: "Q&A", emoji: "🙏" }
  isAnswered: boolean;
  author: { login: string; avatarUrl: string };
  commentCount: number;
  upvoteCount: number;
  locked: boolean;
  body?: string;
};
```

### 3.5 Slack Thread

```ts
type SlackThreadMeta = {
  type: 'slack_thread';
  workspaceName: string;               // Slack workspace name (e.g. "Helmor")
  channelId: string;                   // "C012345"
  channelName: string;                 // "#engineering"
  threadTs: string;                    // parent message timestamp
  rootMessageText: string;             // first message (plain text, may be truncated)
  rootAuthor: { name: string; avatarUrl: string };
  replyCount: number;
  participants: { name: string; avatarUrl: string }[];   // top N participants
  permalink: string;                   // resolvable via chat.getPermalink
};
```

---

## 4. Workspace `draftMessage` shape (for prepared workspaces)

This is the unified draft-message storage. It REPLACES the existing localStorage-based composer drafts (one of the goals of this work is to consolidate).

```ts
type Workspace = {
  // ... existing fields (id, repo, branch, status, ...)
  status: 'backlog' | 'in_progress' | 'done' | /* ... */;

  // NEW — replaces all localStorage drafts
  draftMessage: {
    content: string;                       // composer text content
    contextCardIds: string[];              // attached source card IDs
    repoId?: string;                       // selected repo at composer level
    targetColumn: 'backlog' | 'in_progress';  // determines composer button label
    updatedAt: number;
  } | null;
};
```

A workspace is **"prepared"** when `status === 'backlog' && draftMessage != null`. The Backlog card's prepared indicator (Section 1.4) appears in this case.

The composer-overlay loading rule for prepared workspaces:
1. If `draftMessage` exists → render its content + chips, button label from `draftMessage.targetColumn`
2. Else (regular workspace, fresh composer) → empty state

LocalStorage drafts are deprecated; on first load of a workspace whose composer used to have a localStorage draft, migrate it into `draftMessage` then clear localStorage.

---

## 5. Existing system to reuse / be aware of

### 5.1 Composer (DO NOT re-implement — wrap it)

- Location: `src/features/composer/`
- Editor framework: Lexical (plugins under `src/features/composer/editor/plugins/`)
- Already supports inserting context chips (the user pointed to the existing `/add-dir` UX as the reference pattern)
- The new composer-overlay is a NEW WRAPPER that:
  1. Floats on top of the kanban
  2. Adds a repo dropdown to the left of the send button
  3. Switches the send button label based on `draftMessage.targetColumn`
  4. Accepts dragged-in inbox source cards as additional chips

### 5.2 Kanban (already built — extend)

- Location: `src/features/kanban/`
- Components: `index.tsx` (KanbanPage), `column.tsx`, `card.tsx` (KanbanCard + KanbanCardPreview)
- Cards in kanban use `KanbanCardPreview` — a distinct component from the inbox source card (do not unify these)
- DnD context currently lives in `src/features/kanban/index.tsx`. For cross-region drag from sidebar to kanban (and to composer), the `DndContext` MUST be lifted up to a shared parent — see Section 6.
- Already-implemented utilities (you can build on top):
  - `closestCorners` collision detection
  - `KanbanDropPlaceholder` component shows a ghost in target column
  - `KanbanCardPreview` accepts `dragOverlay` prop for the floating preview

### 5.3 Sidebar shell (current — will be replaced in kanban mode)

- Location: `src/features/navigation/`
- Renders workspace groups (pinned / progress / backlog / etc.)
- Recommendation: introduce a top-level conditional in the layout that swaps `<NavigationSidebar />` ↔ `<InboxSidebar />` based on `workspaceViewMode === 'kanban'`. The swap is instant (no animation needed unless designer wants one).

### 5.4 Recently-added CSS utilities (use these in the new UI)

In `src/App.css`:

```css
.scrollbar-stable             { scrollbar-gutter: stable; }
.scrollbar-stable-symmetric   { scrollbar-gutter: stable both-edges; }   /* symmetric L/R padding */
.scrollbar-none               { scrollbar-width: none; }                  /* hide scrollbar */
.kanban-card-lift             { /* DragOverlay shadow fade-in animation */ }

@keyframes kanban-card-lift {
  from { box-shadow: 0 0 0 rgba(0, 0, 0, 0); }
  to   { box-shadow: 0 8px 20px -4px ..., 0 4px 8px -4px ...; }
}
```

For any drag overlay in the new flows (inbox card lifted up, composer overlay drag), prefer reusing `.kanban-card-lift` for visual consistency.

### 5.5 Design tokens & primitives

- Tailwind v4 with oklch semantic tokens: `bg-app-base`, `text-app-foreground`, `bg-card`, `border-border`, `bg-accent`, `bg-sidebar`, `text-muted-foreground`, etc.
- shadcn/ui base-nova primitives in `src/components/ui/` (`Button`, `Badge`, `DropdownMenu`, etc.)
- `lucide-react` for icons
- Existing helpers worth knowing:
  - `cn()` from `src/lib/utils.ts`
  - `branchToneClasses` from `src/features/navigation/shared.tsx`
  - `WorkspaceAvatar` from `src/features/navigation/avatar.tsx`
  - `humanizeBranch()` from `src/features/navigation/shared.tsx`
  - `getWorkspaceBranchTone()` from `src/lib/workspace-helpers.ts`

### 5.6 Cursor convention (must follow)

Every clickable element MUST have `cursor-pointer`. Already baked into shadcn/ui base components. When adding a custom clickable `<div onClick>`, include `cursor-pointer` explicitly.

---

## 6. DnD architecture (cross-region)

The inbox-to-kanban and inbox-to-composer drags require a **single shared `DndContext`** wrapping both regions. This is a structural change from today.

### Current topology

```
<KanbanPage>
  <DndContext>             // scoped to kanban only
    <KanbanColumn>...</KanbanColumn>  // useDroppable + SortableContext
    <DragOverlay />
  </DndContext>
</KanbanPage>
```

### Required topology

```
<KanbanLayoutShell>            // ← new top-level shell when in kanban mode
  <DndContext>                 // ← lifted up
    <InboxSidebar>             // drag SOURCES (left)
      <SourceCard draggable />
    </InboxSidebar>

    <KanbanBoard>              // existing drop targets (right)
      <KanbanColumn />
    </KanbanBoard>

    {composerOpen && (
      <ComposerOverlay>        // drop target while open (additional chips)
      </ComposerOverlay>
    )}

    <DragOverlay>              // shared overlay layer
      {/* renders inbox SourceCardPresentation OR KanbanCardPreview based on active drag type */}
    </DragOverlay>
  </DndContext>
</KanbanLayoutShell>
```

### Drop semantics summary

| From | To | Effect |
|---|---|---|
| Inbox source card | Backlog column | Open composer overlay, `targetColumn: 'backlog'`, button = `Save to Backlog` |
| Inbox source card | In Progress column | Open composer overlay, `targetColumn: 'in_progress'`, button = `Send` |
| Inbox source card | Other kanban columns | Drop rejected (visual cue: not-allowed cursor or red outline) |
| Inbox source card | Composer overlay (when open) | Append as additional context chip |
| Kanban workspace card | Any kanban column | Existing behavior (status change) |
| Kanban workspace card | Composer overlay | Not supported in v1 |

### Detecting "drop type"

In drag handlers, distinguish by `active.data.current.type`:
- `'workspace-card'` (existing — kanban cards)
- `'context-card'` (NEW — inbox source cards)

---

## 7. Recommended file layout (suggestion, not a contract)

```
src/features/
  inbox/
    index.tsx                          // <InboxSidebar />
    container.tsx                      // data hooks, query integration
    components/
      source-filter.tsx                // top icon tiles
      source-card.tsx                  // unified card component
      source-card-presentation.tsx     // pure visual (used in DragOverlay)
      empty-state.tsx
    hooks/
      use-inbox-cards.ts
      use-source-filter.ts
  composer-overlay/
    index.tsx                          // <ComposerOverlay />
    components/
      repo-picker.tsx                  // dropdown
      context-chip-row.tsx             // chips for attached cards
      composer-overlay-shell.tsx       // floating frame
    hooks/
      use-composer-overlay.ts
      use-prepared-draft.ts
  kanban-layout/                       // NEW shell that swaps sidebars
    index.tsx
src/lib/sources/
  types.ts                             // ContextCard, ContextCardMeta, etc.
  registry.ts                          // central source dispatch
  linear/
    adapter.ts
    mock.ts
  github/
    issue-adapter.ts
    pr-adapter.ts
    discussion-adapter.ts
    mock.ts
  slack/
    adapter.ts
    mock.ts
```

The designer doesn't need to follow this exactly — it's a starting point that respects Helmor's existing feature-folder convention (see `CLAUDE.md` § Code organization rules).

---

## 8. Out of scope for this UI design pass

The designer should NOT design for these. They are explicitly deferred or descoped:

- ❌ Real source data fetching (auth, OAuth, polling, webhooks) — v1 uses mock data
- ❌ Search/browse panel inside the composer (only DnD adds context — no search box)
- ❌ Mid-composer target switching (no Save↔Send toggle inside composer; v1 = Esc + redrag if user changes their mind)
- ❌ Showing inbox content in non-kanban modes (Inbox is kanban-only)
- ❌ Helmor workspace cards in Inbox (Inbox = external sources only; Helmor workspaces stay in their own nav)
- ❌ Multi-select drag of multiple inbox cards at once (v1 = single-card drag)
- ❌ Inbox cards as drop TARGETS (they're only DnD sources)
- ❌ Settings UI for adding/removing sources, configuring filters beyond source-type tabs

---

## 9. Tech stack reminders

- **Tauri v2** webview = Chromium on macOS/Linux, WebKit on macOS only when forced. Treat as Chromium for CSS. No need for legacy browser fallbacks.
- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4** with CSS-first config (`@utility` for custom utilities). Path alias: `@/` → `src/`
- **@dnd-kit/core** + **@dnd-kit/sortable** + **@dnd-kit/utilities**
- **shadcn/ui** (base-nova) for primitives
- **Lexical** for the rich-text composer (already wired)
- **lucide-react** for icons
- **TanStack React Query** for server state

---

## 10. Reference docs in this repo (for the designer to skim)

- `CLAUDE.md` — project conventions, code organization, debugging
- `research_kanban_ui/findings_scrollbar.md` — modern scrollbar handling (used `.scrollbar-stable-symmetric`)
- `research_kanban_ui/findings_dndkit.md` — dnd-kit DragOverlay patterns (used `.kanban-card-lift`)
- `research_kanban_ui/findings_empty_columns.md` — empty droppable column tricks
- `src/features/kanban/` — completed kanban UI (visual reference for card style)
- `src/features/composer/` — existing composer to wrap
- `src/features/navigation/` — existing sidebar shell (the thing we'll swap)
- `src/App.css` — global utilities + tokens

---

End of context doc. The designer can use this as the source of truth for what data is available, what behavior is locked, and what existing pieces to plug into. Visual decisions (color, hierarchy, density, motion) are theirs to make.
