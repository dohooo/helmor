import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	stripSearchParams,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import {
	locationToViewInfo,
	pathToSelection,
	selectionToLocation,
	selectionToPath,
} from "./location-mapping";

describe("selectionToPath", () => {
	it("maps the start surface to /start, ignoring any ids", () => {
		expect(
			selectionToPath({
				viewMode: "start",
				workspaceId: null,
				sessionId: null,
			}),
		).toBe("/start");
		// Start wins even if stale ids linger.
		expect(
			selectionToPath({ viewMode: "start", workspaceId: "ws", sessionId: "s" }),
		).toBe("/start");
	});

	it("maps workspace + session to /w/<ws>/s/<sid>", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				sessionId: "sess1",
			}),
		).toBe("/w/ws1/s/sess1");
	});

	it("maps workspace only to /w/<ws>", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "ws1",
				sessionId: null,
			}),
		).toBe("/w/ws1");
	});

	it("maps a missing non-start workspace to the boot index /", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: null,
				sessionId: null,
			}),
		).toBe("/");
		// A session without a workspace is not addressable → boot index.
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: null,
				sessionId: "orphan",
			}),
		).toBe("/");
	});

	it("treats the editor view-mode the same as conversation for the PATH", () => {
		// Editor differs only via the `?view` search param; the pathname is shared.
		expect(
			selectionToPath({
				viewMode: "editor",
				workspaceId: "ws1",
				sessionId: "sess1",
			}),
		).toBe("/w/ws1/s/sess1");
	});

	it("encodes ids containing URL-special characters", () => {
		expect(
			selectionToPath({
				viewMode: "conversation",
				workspaceId: "repo/feature branch",
				sessionId: "id with space & symbols?#",
			}),
		).toBe(
			`/w/${encodeURIComponent("repo/feature branch")}/s/${encodeURIComponent(
				"id with space & symbols?#",
			)}`,
		);
	});
});

describe("selectionToLocation", () => {
	it("maps the start surface to the DISTINCT /start route (not /)", () => {
		expect(
			selectionToLocation({
				viewMode: "start",
				workspaceId: null,
				sessionId: null,
			}),
		).toEqual({ to: "/start" });
		// Start is its own route even with stale ids — the fix that un-conflates
		// "start" from "conversation + no workspace".
		expect(
			selectionToLocation({
				viewMode: "start",
				workspaceId: "ws1",
				sessionId: "sess1",
			}),
		).toEqual({ to: "/start" });
	});

	it("maps a missing non-start workspace to the boot index /", () => {
		// Distinct target from /start: this is the transient pre-auto-select index.
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: null,
				sessionId: null,
			}),
		).toEqual({ to: "/" });
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: null,
				sessionId: "orphan",
			}),
		).toEqual({ to: "/" });
	});

	it("maps conversation + workspace + session with the conversation default", () => {
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: "ws1",
				sessionId: "sess1",
			}),
		).toEqual({
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId: "ws1", sessionId: "sess1" },
			search: { view: "conversation" },
		});
	});

	it("maps conversation + workspace only", () => {
		expect(
			selectionToLocation({
				viewMode: "conversation",
				workspaceId: "ws1",
				sessionId: null,
			}),
		).toEqual({
			to: "/w/$workspaceId",
			params: { workspaceId: "ws1" },
			search: { view: "conversation" },
		});
	});

	it("maps editor + workspace + session with ?view=editor", () => {
		expect(
			selectionToLocation({
				viewMode: "editor",
				workspaceId: "ws1",
				sessionId: "sess1",
			}),
		).toEqual({
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId: "ws1", sessionId: "sess1" },
			search: { view: "editor" },
		});
	});

	it("maps editor + workspace only with ?view=editor", () => {
		expect(
			selectionToLocation({
				viewMode: "editor",
				workspaceId: "ws1",
				sessionId: null,
			}),
		).toEqual({
			to: "/w/$workspaceId",
			params: { workspaceId: "ws1" },
			search: { view: "editor" },
		});
	});
});

describe("pathToSelection", () => {
	it("parses /w/<ws>/s/<sid>", () => {
		expect(pathToSelection("/w/ws1/s/sess1")).toEqual({
			workspaceId: "ws1",
			sessionId: "sess1",
		});
	});

	it("parses /w/<ws>", () => {
		expect(pathToSelection("/w/ws1")).toEqual({
			workspaceId: "ws1",
			sessionId: null,
		});
	});

	it("parses the boot index / as no selection", () => {
		expect(pathToSelection("/")).toEqual({
			workspaceId: null,
			sessionId: null,
		});
	});

	it("parses /start as no selection (view distinguished separately)", () => {
		// `/start` has no workspace; `locationToViewInfo` is what tells it apart
		// from the bare `/` boot index.
		expect(pathToSelection("/start")).toEqual({
			workspaceId: null,
			sessionId: null,
		});
	});

	it("returns no selection for unrecognised paths", () => {
		expect(pathToSelection("/something/else")).toEqual({
			workspaceId: null,
			sessionId: null,
		});
	});

	it("decodes URL-special characters", () => {
		const workspaceId = "repo/feature branch";
		const sessionId = "id with space & symbols?";
		const path = `/w/${encodeURIComponent(workspaceId)}/s/${encodeURIComponent(
			sessionId,
		)}`;
		expect(pathToSelection(path)).toEqual({ workspaceId, sessionId });
	});
});

describe("locationToViewInfo", () => {
	it("flags /start as start, conversation elsewhere", () => {
		expect(locationToViewInfo({ pathname: "/start", search: {} })).toEqual({
			isStart: true,
			isEditor: false,
		});
		expect(locationToViewInfo({ pathname: "/", search: {} })).toEqual({
			isStart: false,
			isEditor: false,
		});
		expect(
			locationToViewInfo({ pathname: "/w/ws1/s/sess1", search: {} }),
		).toEqual({ isStart: false, isEditor: false });
	});

	it("flags ?view=editor as editor", () => {
		expect(
			locationToViewInfo({ pathname: "/w/ws1", search: { view: "editor" } }),
		).toEqual({ isStart: false, isEditor: true });
		expect(
			locationToViewInfo({
				pathname: "/w/ws1/s/sess1",
				search: { view: "editor" },
			}),
		).toEqual({ isStart: false, isEditor: true });
	});

	it("treats an absent or conversation view as conversation (not editor)", () => {
		// The strip middleware removes the conversation default, so the stored
		// search is `{}` for conversation — that must read as NOT editor.
		expect(
			locationToViewInfo({ pathname: "/w/ws1", search: {} }).isEditor,
		).toBe(false);
		expect(
			locationToViewInfo({
				pathname: "/w/ws1",
				search: { view: "conversation" },
			}).isEditor,
		).toBe(false);
	});
});

describe("round-trip (path)", () => {
	const cases: Array<{
		workspaceId: string | null;
		sessionId: string | null;
	}> = [
		{ workspaceId: null, sessionId: null },
		{ workspaceId: "ws1", sessionId: null },
		{ workspaceId: "ws1", sessionId: "sess1" },
		{ workspaceId: "repo/feature branch", sessionId: "id with space & ?#" },
	];

	for (const { workspaceId, sessionId } of cases) {
		it(`selectionToPath ∘ pathToSelection is identity for ${JSON.stringify({
			workspaceId,
			sessionId,
		})}`, () => {
			const path = selectionToPath({
				viewMode: "conversation",
				workspaceId,
				sessionId,
			});
			expect(pathToSelection(path)).toEqual({ workspaceId, sessionId });
		});
	}
});

// Pin the encoding contract the mirror's equality gate relies on against a REAL
// router whose route tree matches `src/router/index.tsx` (distinct `/start`,
// `?view` search param with the conversation default stripped). Facts the gate
// depends on:
//   1. For plain ids (Helmor's are UUID v4), `selectionToPath` is byte-equal to
//      `router.state.location.pathname`.
//   2. For ids with URL-reserved chars TanStack normalises the stored pathname
//      with `decodeURI`, so a raw-string compare is NOT reliable — the gate
//      falls back to `pathToSelection`, which must round-trip to the same ids.
//   3. Editor → stored `search.view === "editor"`; conversation → stored search
//      `{}` (the default is stripped). `/start` is a real, distinct location.
describe("router location round-trips through the mapping", () => {
	function makeRouter() {
		const rootRoute = createRootRoute();
		const indexRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/",
			component: () => null,
		});
		const startRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/start",
			component: () => null,
		});
		const validateView = (search: Record<string, unknown>) => ({
			view:
				search.view === "editor"
					? ("editor" as const)
					: ("conversation" as const),
		});
		const stripDefault = stripSearchParams<{
			view: "conversation" | "editor";
		}>({ view: "conversation" });
		const workspaceRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/w/$workspaceId",
			component: () => null,
			validateSearch: validateView,
			search: { middlewares: [stripDefault] },
		});
		const sessionRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: "/w/$workspaceId/s/$sessionId",
			component: () => null,
			validateSearch: validateView,
			search: { middlewares: [stripDefault] },
		});
		const routeTree = rootRoute.addChildren([
			indexRoute,
			startRoute,
			workspaceRoute,
			sessionRoute,
		]);
		return createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
	}

	it("is byte-equal to selectionToPath for plain (UUID-like) ids", async () => {
		const router = makeRouter();
		await router.load();

		const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
		const sessionId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
		await router.navigate({
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId, sessionId },
			search: { view: "conversation" },
		});
		expect(router.state.location.pathname).toBe(
			selectionToPath({ viewMode: "conversation", workspaceId, sessionId }),
		);
	});

	it("round-trips ids with URL-special characters via pathToSelection", async () => {
		const router = makeRouter();
		await router.load();

		const workspaceId = "repo/feature branch";
		const sessionId = "id with space & symbols?#";
		await router.navigate({
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId, sessionId },
			search: { view: "conversation" },
		});
		expect(pathToSelection(router.state.location.pathname)).toEqual({
			workspaceId,
			sessionId,
		});
	});

	it("strips the conversation default from the stored search", async () => {
		const router = makeRouter();
		await router.load();
		await router.navigate({
			to: "/w/$workspaceId",
			params: { workspaceId: "ws1" },
			search: { view: "conversation" },
		});
		// Default stripped → stored search has no `view`, reads as conversation.
		expect(router.state.location.search).toEqual({});
		expect(
			locationToViewInfo({
				pathname: router.state.location.pathname,
				search: router.state.location.search,
			}),
		).toEqual({ isStart: false, isEditor: false });
	});

	it("keeps ?view=editor in the stored search", async () => {
		const router = makeRouter();
		await router.load();
		await router.navigate({
			to: "/w/$workspaceId/s/$sessionId",
			params: { workspaceId: "ws1", sessionId: "sess1" },
			search: { view: "editor" },
		});
		expect(router.state.location.search).toEqual({ view: "editor" });
		expect(router.state.location.searchStr).toBe("?view=editor");
		expect(
			locationToViewInfo({
				pathname: router.state.location.pathname,
				search: router.state.location.search,
			}),
		).toEqual({ isStart: false, isEditor: true });
	});

	it("navigates to the distinct /start route", async () => {
		const router = makeRouter();
		await router.load();
		await router.navigate({ to: "/start" });
		expect(router.state.location.pathname).toBe("/start");
		expect(
			locationToViewInfo({
				pathname: router.state.location.pathname,
				search: router.state.location.search,
			}),
		).toEqual({ isStart: true, isEditor: false });
	});

	it("a bogus ?view never throws and falls back to conversation", async () => {
		const router = makeRouter();
		await router.load();
		await router.navigate({
			to: "/w/$workspaceId",
			params: { workspaceId: "ws1" },
			// biome-ignore lint/suspicious/noExplicitAny: intentionally bogus input
			search: { view: "garbage" } as any,
		});
		// validateSearch coerces to "conversation", which is then stripped.
		expect(router.state.location.search).toEqual({});
		expect(
			locationToViewInfo({
				pathname: router.state.location.pathname,
				search: router.state.location.search,
			}).isEditor,
		).toBe(false);
	});
});
