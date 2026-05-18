import type { ShortcutScope } from "./types";

// DOM contract: any container can opt in to a focus scope by setting
// `data-focus-scope="chat" | "composer" | "terminal" | "editor"`. The active
// scope set is resolved at dispatch time by walking from
// `document.activeElement` up to the document root, collecting every tagged
// ancestor (so nested scopes like composer-inside-chat both apply).
export const FOCUS_SCOPE_ATTRIBUTE = "data-focus-scope";

const KNOWN_SCOPES: ReadonlySet<ShortcutScope> = new Set([
	"app",
	"chat",
	"composer",
	"terminal",
	"editor",
]);

// Scope inheritance: when a leaf scope is active, every parent scope is also
// considered active. The composer is a sibling of the chat panel in the DOM
// (not a descendant), but semantically it IS chat — so chat-bound shortcuts
// (Cmd+T, Cmd+W, session navigation) must keep firing while typing.
const SCOPE_PARENTS: Partial<Record<ShortcutScope, readonly ShortcutScope[]>> =
	{
		composer: ["chat"],
	};

export const DEFAULT_FOCUS_SCOPE: ShortcutScope = "chat";

// Most recently engaged scope (focus or click). Pointer is needed because
// xterm keeps DOM focus on its hidden textarea even after the user clicks
// elsewhere. `null` = no engagement yet (distinct from chat-the-default).
let lastEngagedScope: ShortcutScope | null = null;

function readScopesFrom(element: Element | null): ShortcutScope[] {
	if (!element) return [];
	const collected: ShortcutScope[] = [];
	let cursor: Element | null = element.closest(`[${FOCUS_SCOPE_ATTRIBUTE}]`);
	while (cursor) {
		const value = cursor.getAttribute(FOCUS_SCOPE_ATTRIBUTE);
		if (value && KNOWN_SCOPES.has(value as ShortcutScope)) {
			const scope = value as ShortcutScope;
			if (!collected.includes(scope)) collected.push(scope);
		}
		const parent: Element | null = cursor.parentElement;
		cursor = parent?.closest(`[${FOCUS_SCOPE_ATTRIBUTE}]`) ?? null;
	}
	return collected;
}

function withInheritedParents(
	scopes: readonly ShortcutScope[],
): ShortcutScope[] {
	const out: ShortcutScope[] = [];
	const append = (scope: ShortcutScope) => {
		if (out.includes(scope)) return;
		out.push(scope);
		for (const parent of SCOPE_PARENTS[scope] ?? []) append(parent);
	};
	for (const scope of scopes) append(scope);
	return out;
}

function rememberEngagement(target: Element | null): void {
	if (!target) return;
	const scopes = readScopesFrom(target);
	lastEngagedScope = scopes[0] ?? null;
}

if (typeof document !== "undefined") {
	document.addEventListener(
		"focusin",
		(event) => {
			const target = event.target as Element | null;
			// Body picks up focus when the previously-focused element is
			// removed (e.g. xterm unmounted on tab close). Treat that as a
			// transient focus loss and keep the sticky memory.
			if (!target || target === document.body) return;
			rememberEngagement(target);
		},
		true,
	);

	// Click engagement: covers non-focusable click targets (chat messages,
	// padding) where focusin doesn't fire and xterm holds DOM focus.
	document.addEventListener(
		"pointerdown",
		(event) => {
			rememberEngagement(event.target as Element | null);
		},
		true,
	);
}

// Returns every scope active for the current focus, leaf-first, with
// SCOPE_PARENTS expanded so semantic parents (e.g. composer ⊂ chat) come
// along automatically. When focus is outside any tagged container —
// sidebar, top chrome — falls back to the default scope.
export function getActiveScopes(): ShortcutScope[] {
	return withInheritedParents(computeActiveLeafScopes());
}

function computeActiveLeafScopes(): readonly ShortcutScope[] {
	if (typeof document === "undefined") {
		return [lastEngagedScope ?? DEFAULT_FOCUS_SCOPE];
	}
	const active = document.activeElement;
	if (active && active !== document.body) {
		const scopes = readScopesFrom(active);
		if (scopes.length > 0) {
			// Trust focus if engagement agrees (or is unset); otherwise the
			// click wins — handles xterm keeping focus on its textarea.
			const expanded = withInheritedParents(scopes);
			if (lastEngagedScope === null || expanded.includes(lastEngagedScope)) {
				return scopes;
			}
			const stillMounted = document.querySelector(
				`[${FOCUS_SCOPE_ATTRIBUTE}="${lastEngagedScope}"]`,
			);
			if (stillMounted) return [lastEngagedScope];
			return scopes;
		}
		// Real focus owner lives outside any tagged scope (sidebar, top
		// chrome). Honor a sticky engagement that still exists, otherwise
		// fall back to the default.
		if (lastEngagedScope !== null) {
			const stillMounted = document.querySelector(
				`[${FOCUS_SCOPE_ATTRIBUTE}="${lastEngagedScope}"]`,
			);
			if (stillMounted) return [lastEngagedScope];
		}
		return [DEFAULT_FOCUS_SCOPE];
	}
	// activeElement === body — transient focus loss (e.g. focused element
	// just unmounted). Honor sticky only if its scope container still
	// exists in the DOM; otherwise the panel is gone and the sticky memory
	// is stale.
	if (lastEngagedScope === null) return [DEFAULT_FOCUS_SCOPE];
	const stillMounted = document.querySelector(
		`[${FOCUS_SCOPE_ATTRIBUTE}="${lastEngagedScope}"]`,
	);
	return stillMounted ? [lastEngagedScope] : [DEFAULT_FOCUS_SCOPE];
}

/** Test-only: reset the sticky scope memory between tests. */
export function _resetActiveScopeForTesting() {
	lastEngagedScope = null;
}
