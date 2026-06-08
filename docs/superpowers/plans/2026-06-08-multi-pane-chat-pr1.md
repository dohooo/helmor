# Multi-pane chat — PR 1: PanesProvider + grid scaffolding (single-pane mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `src/shell/panes/` module — `PanesProvider`, `PanesGrid`, `PaneShell`, `PaneIdentityContext`, `PaneErrorBoundary` — and insert `<PanesGrid>` between Helmor's existing shell and `<PanelContainer>`, so the app renders the same single-pane experience but through the new plumbing. Zero observable behavior change.

**Architecture:** `PanesProvider` owns `Pane[]` + `focusedPaneId`. PR 1's provider initializes with one `Pane` whose `(workspaceId, sessionId)` mirrors the existing `useAppShellState` selection (read-through). `PanesGrid` renders one cell in a 1×1 layout. `PaneShell` injects pane identity into `PaneIdentityContext` and renders the existing `<PanelContainer>` unchanged. `PanelContainer` still reads workspace/session from the singleton — the new context exists but is not yet consumed (that's PR 2). Result: identical UI, but the future seam is in place.

**Tech Stack:** React 19, TypeScript, Vitest (jsdom + @testing-library/react), Tailwind v4. Path alias `@/` → `src/`. Test command: `bun x vitest run <file>`.

---

## Scope and what's deferred

This plan covers **PR 1 only**. The 6-PR sequencing from the spec (§9 of `docs/superpowers/specs/2026-06-08-multi-pane-chat-design.md`) is:

1. **PR 1 (this plan)** — provider + grid scaffolding, single-pane mode.
2. PR 2 — `PanelContainer` consumes pane context instead of singleton.
3. PR 3 — open a 2nd pane (cap 2, 1×2 grid).
4. PR 4 — detached-window plumbing.
5. PR 5 — soft cap 6 + 2×2 grid.
6. PR 6 — layout persistence to `localStorage`.

PRs 2–6 will be planned in their own files after PR 1 lands so we can incorporate what we learn from PR 1's review feedback.

## File structure for PR 1

| Path | Status | Responsibility |
|---|---|---|
| `src/shell/panes/types.ts` | Create | `Pane`, `PaneTarget`, `PaneIdentity` types. |
| `src/shell/panes/identity-context.tsx` | Create | `PaneIdentityContext` + `usePaneIdentity()` hook. |
| `src/shell/panes/provider.tsx` | Create | `PanesProvider`, reducer, `usePanes()` hook. |
| `src/shell/panes/error-boundary.tsx` | Create | `PaneErrorBoundary` — catches and shows reload affordance. |
| `src/shell/panes/pane-shell.tsx` | Create | Thin wrapper: provides identity context + error boundary, renders children. |
| `src/shell/panes/grid.tsx` | Create | 1×1 CSS-grid layout. Renders one `<PaneShell>` per main-target pane. |
| `src/shell/panes/index.ts` | Create | Barrel re-exporting the module's public API. |
| `src/shell/components/app-shell-layout.tsx` | Modify | Replace the direct `<PanelContainer>` mount point with `<PanesGrid>`. |
| `src/shell/components/app-shell-provider-stack.tsx` | Modify | Add `<PanesProvider>` wrap. |

Test files (created alongside their source files):
- `src/shell/panes/provider.test.tsx`
- `src/shell/panes/grid.test.tsx`
- `src/shell/panes/pane-shell.test.tsx`
- `src/shell/panes/error-boundary.test.tsx`
- `src/shell/panes/identity-context.test.tsx`

## Conventions and gotchas

- **Test command** for any single file: `bun x vitest run <path-from-repo-root>`.
- **Pre-commit hook** runs Biome on JS/TS staged files (will reformat / lint). Commit messages must NOT contain AI/Claude signatures or trailers (project preference).
- **Element id source.** Use `crypto.randomUUID()` (available in jsdom and the webview). Do NOT add a `nanoid` dependency.
- **No window globals.** `PanesProvider`'s reducer is pure — do not read `localStorage` in PR 1 (persistence is PR 6).
- **Imports** use `@/` not relative paths above two levels.
- **No new exports from `src/lib/api.ts`** — Tauri command plumbing is added in PR 4.

---

## Task 1: Add the `Pane` type

**Files:**
- Create: `src/shell/panes/types.ts`

- [ ] **Step 1: Create the file.**

```ts
// src/shell/panes/types.ts

/**
 * Where a pane lives. `"main"` = a cell in the main window's grid.
 * `{ window: <label> }` = a detached Tauri WebviewWindow (PR 4+).
 */
export type PaneTarget = "main" | { window: string };

/**
 * One open chat surface. PR 1 only ever creates a single pane with
 * id `"default"` and target `"main"`. The fields are shaped for the full
 * multi-pane feature so later PRs can fill them out without renaming.
 */
export interface Pane {
	id: string;
	workspaceId: string | null;
	sessionId: string | null;
	target: PaneTarget;
}

/**
 * Subset of `Pane` exposed to descendants of `<PaneShell>` via context. Kept
 * narrow so future fields on `Pane` don't ripple into every consumer.
 */
export interface PaneIdentity {
	paneId: string;
	workspaceId: string | null;
	sessionId: string | null;
}
```

- [ ] **Step 2: Confirm the file typechecks.**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit.**

```bash
git add src/shell/panes/types.ts
git commit -m "feat(panes): add Pane and PaneIdentity types"
```

---

## Task 2: `PaneIdentityContext` + `usePaneIdentity` hook

**Files:**
- Create: `src/shell/panes/identity-context.tsx`
- Test: `src/shell/panes/identity-context.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
// src/shell/panes/identity-context.test.tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneIdentityContext, usePaneIdentity } from "./identity-context";
import type { PaneIdentity } from "./types";

describe("usePaneIdentity", () => {
	it("returns the value provided by the context", () => {
		const value: PaneIdentity = {
			paneId: "p1",
			workspaceId: "ws-a",
			sessionId: "s-x",
		};
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<PaneIdentityContext.Provider value={value}>
				{children}
			</PaneIdentityContext.Provider>
		);
		const { result } = renderHook(() => usePaneIdentity(), { wrapper });
		expect(result.current).toEqual(value);
	});

	it("throws when used outside a provider", () => {
		expect(() => renderHook(() => usePaneIdentity())).toThrowError(
			/usePaneIdentity must be used inside <PaneShell>/,
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/identity-context.test.tsx`
Expected: FAIL — `Cannot find module './identity-context'`.

- [ ] **Step 3: Write the minimal implementation.**

```tsx
// src/shell/panes/identity-context.tsx
import { createContext, useContext } from "react";
import type { PaneIdentity } from "./types";

export const PaneIdentityContext = createContext<PaneIdentity | null>(null);

export function usePaneIdentity(): PaneIdentity {
	const value = useContext(PaneIdentityContext);
	if (!value) {
		throw new Error(
			"usePaneIdentity must be used inside <PaneShell>. Check that <PanesProvider> + <PanesGrid> wrap this subtree.",
		);
	}
	return value;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/identity-context.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/identity-context.tsx src/shell/panes/identity-context.test.tsx
git commit -m "feat(panes): add PaneIdentityContext + usePaneIdentity hook"
```

---

## Task 3: `PanesProvider` reducer (pure)

**Files:**
- Create: `src/shell/panes/provider.tsx` (initial reducer-only export — the React provider component is added in Task 4)
- Test: `src/shell/panes/provider.test.tsx`

This task introduces the pure reducer used by `PanesProvider`. PR 1 uses only `initial` and `replaceTarget`; the broader op surface is added in later PRs. Defining the action union now (without implementations) would invite stale dead code; we will widen the action type when each later PR needs it.

- [ ] **Step 1: Write the failing test.**

```tsx
// src/shell/panes/provider.test.tsx
import { describe, expect, it } from "vitest";
import { initialPanesState, panesReducer } from "./provider";

describe("panesReducer", () => {
	it("seeds with a single default pane targeting main", () => {
		const state = initialPanesState();
		expect(state.panes).toHaveLength(1);
		expect(state.panes[0]).toMatchObject({
			id: "default",
			workspaceId: null,
			sessionId: null,
			target: "main",
		});
		expect(state.focusedPaneId).toBe("default");
	});

	it("replaceTarget updates only workspaceId + sessionId on the matched pane", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "default",
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
		expect(next.panes[0]).toEqual({
			id: "default",
			workspaceId: "ws-a",
			sessionId: "s-x",
			target: "main",
		});
		expect(next.focusedPaneId).toBe("default");
	});

	it("replaceTarget on an unknown id is a no-op", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "missing",
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
		expect(next).toBe(state);
	});

	it("returns the same object when nothing changed", () => {
		const state = initialPanesState();
		const next = panesReducer(state, {
			type: "replaceTarget",
			paneId: "default",
			workspaceId: null,
			sessionId: null,
		});
		expect(next).toBe(state);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: FAIL — `Cannot find module './provider'`.

- [ ] **Step 3: Write the minimal implementation.**

```tsx
// src/shell/panes/provider.tsx
import type { Pane } from "./types";

export interface PanesState {
	panes: Pane[];
	focusedPaneId: string | null;
}

export type PanesAction = {
	type: "replaceTarget";
	paneId: string;
	workspaceId: string | null;
	sessionId: string | null;
};

export function initialPanesState(): PanesState {
	return {
		panes: [
			{ id: "default", workspaceId: null, sessionId: null, target: "main" },
		],
		focusedPaneId: "default",
	};
}

export function panesReducer(
	state: PanesState,
	action: PanesAction,
): PanesState {
	switch (action.type) {
		case "replaceTarget": {
			const index = state.panes.findIndex((pane) => pane.id === action.paneId);
			if (index === -1) return state;
			const pane = state.panes[index];
			if (
				pane.workspaceId === action.workspaceId &&
				pane.sessionId === action.sessionId
			) {
				return state;
			}
			const next = state.panes.slice();
			next[index] = {
				...pane,
				workspaceId: action.workspaceId,
				sessionId: action.sessionId,
			};
			return { ...state, panes: next };
		}
	}
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/provider.tsx src/shell/panes/provider.test.tsx
git commit -m "feat(panes): add panes reducer + initial single-pane state"
```

---

## Task 4: `PanesProvider` React component + `usePanes()`

**Files:**
- Modify: `src/shell/panes/provider.tsx` (add the component + hook below the reducer)
- Modify: `src/shell/panes/provider.test.tsx` (add tests for the hook)

- [ ] **Step 1: Add the failing tests at the bottom of `provider.test.tsx`.**

```tsx
// append to src/shell/panes/provider.test.tsx
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PanesProvider, usePanes } from "./provider";

describe("PanesProvider", () => {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<PanesProvider>{children}</PanesProvider>
	);

	it("exposes the seeded single pane", () => {
		const { result } = renderHook(() => usePanes(), { wrapper });
		expect(result.current.panes).toHaveLength(1);
		expect(result.current.focusedPaneId).toBe("default");
	});

	it("replaceTarget swaps the pane's workspace + session", () => {
		const { result } = renderHook(() => usePanes(), { wrapper });
		act(() => {
			result.current.replaceTarget("default", {
				workspaceId: "ws-a",
				sessionId: "s-x",
			});
		});
		expect(result.current.panes[0]).toMatchObject({
			workspaceId: "ws-a",
			sessionId: "s-x",
		});
	});

	it("usePanes throws when used outside the provider", () => {
		expect(() => renderHook(() => usePanes())).toThrowError(
			/usePanes must be used inside <PanesProvider>/,
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: FAIL — `PanesProvider` / `usePanes` not exported.

- [ ] **Step 3: Append the implementation to `provider.tsx`.**

Add the following after the existing reducer code:

```tsx
// append to src/shell/panes/provider.tsx
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useReducer,
	type ReactNode,
} from "react";

export interface PanesContextValue {
	panes: Pane[];
	focusedPaneId: string | null;
	replaceTarget: (
		paneId: string,
		target: { workspaceId: string | null; sessionId: string | null },
	) => void;
}

const PanesContext = createContext<PanesContextValue | null>(null);

export function PanesProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(panesReducer, undefined, initialPanesState);

	const replaceTarget = useCallback<PanesContextValue["replaceTarget"]>(
		(paneId, target) => {
			dispatch({
				type: "replaceTarget",
				paneId,
				workspaceId: target.workspaceId,
				sessionId: target.sessionId,
			});
		},
		[],
	);

	const value = useMemo<PanesContextValue>(
		() => ({
			panes: state.panes,
			focusedPaneId: state.focusedPaneId,
			replaceTarget,
		}),
		[state, replaceTarget],
	);

	return <PanesContext.Provider value={value}>{children}</PanesContext.Provider>;
}

export function usePanes(): PanesContextValue {
	const value = useContext(PanesContext);
	if (!value) {
		throw new Error(
			"usePanes must be used inside <PanesProvider>. Check the provider tree.",
		);
	}
	return value;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: PASS (7 tests total — 4 reducer + 3 provider).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/provider.tsx src/shell/panes/provider.test.tsx
git commit -m "feat(panes): add PanesProvider component + usePanes hook"
```

---

## Task 5: `PaneErrorBoundary`

**Files:**
- Create: `src/shell/panes/error-boundary.tsx`
- Test: `src/shell/panes/error-boundary.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
// src/shell/panes/error-boundary.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneErrorBoundary } from "./error-boundary";

function Boom({ fail }: { fail: boolean }) {
	if (fail) throw new Error("boom");
	return <div>ok</div>;
}

describe("PaneErrorBoundary", () => {
	it("renders children when they succeed", () => {
		render(
			<PaneErrorBoundary>
				<Boom fail={false} />
			</PaneErrorBoundary>,
		);
		expect(screen.getByText("ok")).toBeInTheDocument();
	});

	it("renders the reload affordance when a child throws", () => {
		// React 19 still logs the caught error to console.error; suppress noise.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			<PaneErrorBoundary>
				<Boom fail={true} />
			</PaneErrorBoundary>,
		);
		expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
		spy.mockRestore();
	});

	it("clicking reload re-renders the children", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { rerender } = render(
			<PaneErrorBoundary>
				<Boom fail={true} />
			</PaneErrorBoundary>,
		);
		fireEvent.click(screen.getByRole("button", { name: /reload/i }));
		rerender(
			<PaneErrorBoundary>
				<Boom fail={false} />
			</PaneErrorBoundary>,
		);
		expect(screen.getByText("ok")).toBeInTheDocument();
		spy.mockRestore();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/error-boundary.test.tsx`
Expected: FAIL — `Cannot find module './error-boundary'`.

- [ ] **Step 3: Write the minimal implementation.**

```tsx
// src/shell/panes/error-boundary.tsx
import { Component, type ReactNode } from "react";

interface State {
	error: Error | null;
}

export class PaneErrorBoundary extends Component<{ children: ReactNode }, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error): void {
		// Routes into the existing console.error -> tracing::error! bridge.
		console.error("[pane] error caught by PaneErrorBoundary", error);
	}

	private reset = (): void => {
		this.setState({ error: null });
	};

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
					<p className="text-app-foreground/80">This pane crashed.</p>
					<button
						type="button"
						onClick={this.reset}
						className="cursor-pointer rounded-md border border-app-border px-3 py-1.5 text-app-foreground hover:bg-app-elevated"
					>
						Reload pane
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/error-boundary.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/error-boundary.tsx src/shell/panes/error-boundary.test.tsx
git commit -m "feat(panes): add PaneErrorBoundary with reload affordance"
```

---

## Task 6: `PaneShell` (identity + error boundary wrapper)

**Files:**
- Create: `src/shell/panes/pane-shell.tsx`
- Test: `src/shell/panes/pane-shell.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
// src/shell/panes/pane-shell.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePaneIdentity } from "./identity-context";
import { PaneShell } from "./pane-shell";
import type { Pane } from "./types";

function IdentityProbe() {
	const id = usePaneIdentity();
	return (
		<div data-testid="probe">
			{id.paneId}/{id.workspaceId ?? "null"}/{id.sessionId ?? "null"}
		</div>
	);
}

describe("PaneShell", () => {
	it("injects the pane's identity into context", () => {
		const pane: Pane = {
			id: "p1",
			workspaceId: "ws-a",
			sessionId: "s-x",
			target: "main",
		};
		render(
			<PaneShell pane={pane}>
				<IdentityProbe />
			</PaneShell>,
		);
		expect(screen.getByTestId("probe").textContent).toBe("p1/ws-a/s-x");
	});

	it("handles null workspace/session", () => {
		const pane: Pane = {
			id: "p1",
			workspaceId: null,
			sessionId: null,
			target: "main",
		};
		render(
			<PaneShell pane={pane}>
				<IdentityProbe />
			</PaneShell>,
		);
		expect(screen.getByTestId("probe").textContent).toBe("p1/null/null");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/pane-shell.test.tsx`
Expected: FAIL — `Cannot find module './pane-shell'`.

- [ ] **Step 3: Write the minimal implementation.**

```tsx
// src/shell/panes/pane-shell.tsx
import { useMemo, type ReactNode } from "react";
import { PaneErrorBoundary } from "./error-boundary";
import { PaneIdentityContext } from "./identity-context";
import type { Pane, PaneIdentity } from "./types";

interface PaneShellProps {
	pane: Pane;
	children: ReactNode;
}

export function PaneShell({ pane, children }: PaneShellProps) {
	const identity = useMemo<PaneIdentity>(
		() => ({
			paneId: pane.id,
			workspaceId: pane.workspaceId,
			sessionId: pane.sessionId,
		}),
		[pane.id, pane.workspaceId, pane.sessionId],
	);

	return (
		<PaneIdentityContext.Provider value={identity}>
			<PaneErrorBoundary>{children}</PaneErrorBoundary>
		</PaneIdentityContext.Provider>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/pane-shell.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/pane-shell.tsx src/shell/panes/pane-shell.test.tsx
git commit -m "feat(panes): add PaneShell wrapper injecting identity + error boundary"
```

---

## Task 7: `PanesGrid` (1×1 layout)

**Files:**
- Create: `src/shell/panes/grid.tsx`
- Test: `src/shell/panes/grid.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
// src/shell/panes/grid.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanesGrid } from "./grid";
import { PanesProvider } from "./provider";

describe("PanesGrid", () => {
	it("renders one cell per main-target pane in single-pane mode", () => {
		render(
			<PanesProvider>
				<PanesGrid>
					{(pane) => <div data-testid={`cell-${pane.id}`}>cell:{pane.id}</div>}
				</PanesGrid>
			</PanesProvider>,
		);
		const cells = screen.getAllByTestId(/^cell-/);
		expect(cells).toHaveLength(1);
		expect(cells[0].textContent).toBe("cell:default");
	});

	it("uses a 1x1 grid layout class for one pane", () => {
		const { container } = render(
			<PanesProvider>
				<PanesGrid>{() => <div />}</PanesGrid>
			</PanesProvider>,
		);
		// Outermost wrapper exposes the layout via data-attribute so the test
		// doesn't depend on Tailwind class names.
		expect(container.querySelector("[data-panes-layout]")).toHaveAttribute(
			"data-panes-layout",
			"1x1",
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/grid.test.tsx`
Expected: FAIL — `Cannot find module './grid'`.

- [ ] **Step 3: Write the minimal implementation.**

```tsx
// src/shell/panes/grid.tsx
import type { ReactNode } from "react";
import { PaneShell } from "./pane-shell";
import { usePanes } from "./provider";
import type { Pane } from "./types";

type PanesLayout = "1x1" | "1x2" | "2x1" | "2x2";

function layoutFor(count: number): PanesLayout {
	// PR 1 only ever has one main-target pane. Future PRs widen this.
	if (count <= 1) return "1x1";
	if (count === 2) return "1x2";
	return "2x2";
}

interface PanesGridProps {
	children: (pane: Pane) => ReactNode;
}

export function PanesGrid({ children }: PanesGridProps) {
	const { panes } = usePanes();
	const mainPanes = panes.filter((pane) => pane.target === "main");
	const layout = layoutFor(mainPanes.length);

	return (
		<div
			data-panes-layout={layout}
			className="grid h-full w-full"
			style={{ gridTemplateColumns: "1fr" }}
		>
			{mainPanes.map((pane) => (
				<PaneShell key={pane.id} pane={pane}>
					{children(pane)}
				</PaneShell>
			))}
		</div>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/grid.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/grid.tsx src/shell/panes/grid.test.tsx
git commit -m "feat(panes): add PanesGrid with 1x1 layout for single-pane mode"
```

---

## Task 8: Module barrel

**Files:**
- Create: `src/shell/panes/index.ts`

- [ ] **Step 1: Create the file.**

```ts
// src/shell/panes/index.ts
export { PaneIdentityContext, usePaneIdentity } from "./identity-context";
export { PanesProvider, usePanes } from "./provider";
export type { PanesContextValue, PanesState } from "./provider";
export { PaneErrorBoundary } from "./error-boundary";
export { PaneShell } from "./pane-shell";
export { PanesGrid } from "./grid";
export type { Pane, PaneIdentity, PaneTarget } from "./types";
```

- [ ] **Step 2: Confirm the file typechecks.**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/shell/panes/index.ts
git commit -m "feat(panes): add module barrel"
```

---

## Task 9: Sync the pane's identity with the existing selection (read-through)

**Files:**
- Modify: `src/shell/panes/provider.tsx`
- Modify: `src/shell/panes/provider.test.tsx`

Until PR 2 migrates `<PanelContainer>` to consume `usePaneIdentity()`, the pane needs to mirror the existing `useAppShellState` selection so that — when PR 2 flips consumers — the identity in context already matches what the singleton produced.

We do the sync as an opt-in helper hook that PR 1's wiring uses, rather than reaching into the existing shell from inside `PanesProvider` (which would create a circular dependency).

- [ ] **Step 1: Add the failing test.**

Append to `src/shell/panes/provider.test.tsx`:

```tsx
// append to src/shell/panes/provider.test.tsx
import { useSyncDefaultPaneToSelection } from "./provider";

describe("useSyncDefaultPaneToSelection", () => {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<PanesProvider>{children}</PanesProvider>
	);

	it("updates the default pane when the selection changes", () => {
		const { result, rerender } = renderHook(
			(props: { ws: string | null; s: string | null }) => {
				useSyncDefaultPaneToSelection({
					workspaceId: props.ws,
					sessionId: props.s,
				});
				return usePanes();
			},
			{ wrapper, initialProps: { ws: null as string | null, s: null as string | null } },
		);

		expect(result.current.panes[0]).toMatchObject({
			workspaceId: null,
			sessionId: null,
		});

		rerender({ ws: "ws-a", s: "s-x" });
		expect(result.current.panes[0]).toMatchObject({
			workspaceId: "ws-a",
			sessionId: "s-x",
		});

		rerender({ ws: "ws-b", s: "s-y" });
		expect(result.current.panes[0]).toMatchObject({
			workspaceId: "ws-b",
			sessionId: "s-y",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: FAIL — `useSyncDefaultPaneToSelection` not exported.

- [ ] **Step 3: Add the hook to `provider.tsx`.**

Append:

```tsx
// append to src/shell/panes/provider.tsx
import { useEffect } from "react";

/**
 * Mirror the existing app-shell selection onto the default pane. PR 1 uses
 * this so the new PaneIdentityContext stays in lockstep with the legacy
 * singleton; PR 2 inverts the direction (PanelContainer consumes the pane
 * identity, the singleton goes away or becomes a derived view).
 */
export function useSyncDefaultPaneToSelection(target: {
	workspaceId: string | null;
	sessionId: string | null;
}): void {
	const { replaceTarget } = usePanes();
	useEffect(() => {
		replaceTarget("default", {
			workspaceId: target.workspaceId,
			sessionId: target.sessionId,
		});
	}, [replaceTarget, target.workspaceId, target.sessionId]);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun x vitest run src/shell/panes/provider.test.tsx`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit.**

```bash
git add src/shell/panes/provider.tsx src/shell/panes/provider.test.tsx
git commit -m "feat(panes): add useSyncDefaultPaneToSelection hook for PR 1 mirroring"
```

---

## Task 10: Wrap the app shell with `<PanesProvider>`

**Files:**
- Modify: `src/shell/components/app-shell-provider-stack.tsx`

This task locates the existing provider stack and inserts `<PanesProvider>` near the top. The location matters: it must wrap any descendant that may use `usePanes()` or `usePaneIdentity()`, which means inside the React Query / Tauri provider stack but above the panel render.

- [ ] **Step 1: Read the existing provider stack to find the insertion point.**

Run: `head -80 src/shell/components/app-shell-provider-stack.tsx`
Expected: a JSX tree of nested `<XProvider>` wrappers around `children`.

- [ ] **Step 2: Add the import and the wrapper.**

Insert the import alphabetically with the other `@/shell/...` imports:

```tsx
import { PanesProvider } from "@/shell/panes";
```

Then wrap the existing `children` expression with `<PanesProvider>`. If the current bottom of the stack looks like:

```tsx
return (
	<SomeInnermostProvider>
		{children}
	</SomeInnermostProvider>
);
```

change it to:

```tsx
return (
	<SomeInnermostProvider>
		<PanesProvider>{children}</PanesProvider>
	</SomeInnermostProvider>
);
```

- [ ] **Step 3: Confirm the typecheck still passes.**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Confirm the existing app-providers test (if any) still passes.**

Run: `bun x vitest run src/shell/components/`
Expected: PASS for any tests in that directory; no test-collection errors.

- [ ] **Step 5: Commit.**

```bash
git add src/shell/components/app-shell-provider-stack.tsx
git commit -m "feat(panes): wrap app shell in PanesProvider"
```

---

## Task 11: Replace the direct `<PanelContainer>` mount point with `<PanesGrid>`

**Files:**
- Modify: `src/shell/components/app-shell-layout.tsx` (the file that currently renders `<PanelContainer>` in the panel slot — verify with grep)

This task is purely mechanical: where today the layout renders `<PanelContainer {...panelProps} />`, after this task it renders `<PanesGrid>{() => <PanelContainer {...panelProps} />}</PanesGrid>` and uses `useSyncDefaultPaneToSelection` so the pane identity tracks the existing selection.

Critically, `PanelContainer` continues to receive its props from the existing `useAppShellState` orchestration; this PR does not change what makes it tick. The new `PaneIdentityContext` is present but unconsumed.

- [ ] **Step 1: Locate the current PanelContainer mount.**

Run:

```bash
grep -rnE "PanelContainer\b" src/shell/components/
```

Expected: identifies one or two files. The change goes in the file that renders `<PanelContainer ... />` (likely `app-shell-layout.tsx`). If the search returns multiple, the file with a JSX usage (vs an import-only line) is the target.

- [ ] **Step 2: Write the failing integration test.**

Create or extend an existing component test for the layout to confirm `<PanelContainer />` is rendered inside `<PanesGrid />` (assert via the `data-panes-layout` attribute and that the panel content still renders). If `app-shell-layout.test.tsx` does not exist, skip this step and rely on the existing `src/features/panel/container.test.tsx` plus the manual smoke in Task 12.

A reasonable minimal test, if `app-shell-layout.test.tsx` exists:

```tsx
// extend src/shell/components/app-shell-layout.test.tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
// existing imports + renderer omitted; reuse what the file already has

it("hosts the panel inside a PanesGrid", () => {
	renderAppShellLayout(/* the existing helper */);
	expect(document.querySelector("[data-panes-layout]")).toHaveAttribute(
		"data-panes-layout",
		"1x1",
	);
});
```

- [ ] **Step 3: Modify the layout file.**

Add imports near the top of the file (alphabetically inside `@/shell` imports):

```tsx
import { PanesGrid, useSyncDefaultPaneToSelection } from "@/shell/panes";
```

Then in the component body — somewhere near the existing reads of `selectedWorkspaceId` / `selectedSessionId` — add:

```tsx
useSyncDefaultPaneToSelection({
	workspaceId: selectedWorkspaceId,
	sessionId: selectedSessionId,
});
```

And replace the existing direct `<PanelContainer {...panelProps} />` JSX with:

```tsx
<PanesGrid>
	{() => <PanelContainer {...panelProps} />}
</PanesGrid>
```

The unused `pane` parameter from the render-prop is intentional in PR 1; PR 2 will wire it through to `PanelContainer`.

- [ ] **Step 4: Run the frontend tests.**

Run: `bun run test:frontend`
Expected: PASS — including all existing `src/features/panel/*.test.*` files, which continue to render `PanelContainer` directly (without `PanesGrid`) and remain unaffected.

- [ ] **Step 5: Commit.**

```bash
git add src/shell/components/app-shell-layout.tsx
# Include the layout test only if step 2 actually edited it:
# git add src/shell/components/app-shell-layout.test.tsx
git commit -m "feat(panes): render PanelContainer inside PanesGrid (single-pane)"
```

---

## Task 12: Manual smoke check + verification commit gate

**Files:** none modified.

- [ ] **Step 1: Run the full frontend suite.**

Run: `bun run test:frontend`
Expected: PASS, including the new tests in `src/shell/panes/` and every existing test.

- [ ] **Step 2: Run the lint + typecheck.**

Run: `bun run typecheck`
Expected: PASS.
Run: `bun x biome check src/shell/panes`
Expected: PASS (no fixes needed).

- [ ] **Step 3: Boot the app and confirm visual parity.**

Run: `bun run dev`
Expected:
- App starts, sidebar renders, workspaces load.
- Selecting a workspace + session renders the conversation panel exactly as before.
- React DevTools shows `PanesProvider` → `PanesGrid` → `PaneShell` → `PaneErrorBoundary` → `PanelContainer` above the existing tree.
- No new console errors.

- [ ] **Step 4: Stop the dev server.**

`Ctrl+C` in the dev terminal.

- [ ] **Step 5: Final no-op commit (release note).**

Helmor uses changesets per PR. Add one summarizing PR 1:

Create `.changeset/multi-pane-pr1-scaffolding.md` with:

```md
---
"helmor": patch
---

Add the multi-pane shell scaffolding (PanesProvider, PanesGrid, PaneShell, PaneIdentityContext, PaneErrorBoundary). No user-visible change yet; PanelContainer still reads its workspace/session from the existing app-shell state. This is the foundation for surfacing multiple chat sessions in parallel (see docs/superpowers/specs/2026-06-08-multi-pane-chat-design.md).
```

```bash
git add .changeset/multi-pane-pr1-scaffolding.md
git commit -m "chore(changeset): scaffolding for multi-pane chat"
```

---

## After PR 1 merges

PR 2's plan will:
1. Add `workspaceId` / `sessionId` props (or `usePaneIdentity()` reads) to `<PanelContainer>` and its descendants.
2. Replace the `useSyncDefaultPaneToSelection` mirror with the inverse direction: changes inside the pane (via the sidebar or session picker) flow into `PanesProvider`, and the legacy `useSelectionController` becomes a derived view of `usePanes()` or is removed.
3. Audit all 57 of the current `activeSessionId` / `activeWorkspaceId` reads (`grep -rE "activeSessionId|activeWorkspaceId" src/`) and migrate each to `usePaneIdentity()`.

PRs 3–6 follow the §9 sequencing from the spec.

## Self-review notes

Spec coverage for PR 1:
- §4.1 `Pane` type → Task 1.
- §4.2 `PanesProvider` (single-pane variant) → Tasks 3, 4, 9.
- §4.3 `PanesGrid` (1×1 only in PR 1) → Task 7.
- §4.4 `PaneShell` + `PaneIdentityContext` → Tasks 2, 6.
- §7.7 `PaneErrorBoundary` → Task 5.
- §4.5 detached window route → DEFERRED to PR 4 (explicit in the deferral section).
- §6.4 lazy rules → not in PR 1; introduced in PR 2 alongside the consumer migration.
- §8.1 reducer tests → Tasks 3, 4, 9.
- §8.2 grid tests → Task 7.
- §8.3 shell wiring tests → Task 6.
- §8.7 explicit non-tests preserved.

Out of scope (intentional) for PR 1: detached windows, persistence, soft cap, sidebar affordance, lazy subscription. All scheduled for later PRs.
