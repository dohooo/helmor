import { describe, expect, it } from "vitest";
import {
	insertRequestMatchesComposer,
	type ResolvedComposerInsertRequest,
	resolveComposerInsertTarget,
} from "./composer-insert";

describe("resolveComposerInsertTarget", () => {
	it("defaults to the displayed composer target when no explicit target is provided", () => {
		expect(
			resolveComposerInsertTarget(undefined, {
				selectedWorkspaceId: "workspace-selected",
				displayedWorkspaceId: "workspace-displayed",
				displayedSessionId: "session-1",
			}),
		).toEqual({
			workspaceId: "workspace-displayed",
			sessionId: "session-1",
		});
	});

	it("falls back to the selected workspace when no composer is displayed", () => {
		expect(
			resolveComposerInsertTarget(undefined, {
				selectedWorkspaceId: "workspace-selected",
				displayedWorkspaceId: null,
				displayedSessionId: null,
			}),
		).toEqual({
			workspaceId: "workspace-selected",
			sessionId: null,
		});
	});

	it("preserves an explicit target override", () => {
		expect(
			resolveComposerInsertTarget(
				{
					workspaceId: "workspace-explicit",
					sessionId: "session-explicit",
				},
				{
					selectedWorkspaceId: "workspace-selected",
					displayedWorkspaceId: "workspace-displayed",
					displayedSessionId: "session-1",
				},
			),
		).toEqual({
			workspaceId: "workspace-explicit",
			sessionId: "session-explicit",
		});
	});
});

describe("insertRequestMatchesComposer", () => {
	const request = (
		overrides: Partial<ResolvedComposerInsertRequest> = {},
	): ResolvedComposerInsertRequest => ({
		id: "insert-1",
		workspaceId: "workspace-1",
		sessionId: null,
		items: [],
		behavior: "append",
		createdAt: 0,
		...overrides,
	});

	it("matches workspace-scoped requests against any composer in that workspace", () => {
		expect(
			insertRequestMatchesComposer(request(), {
				workspaceId: "workspace-1",
				sessionId: "session-1",
			}),
		).toBe(true);
	});

	it("does not match requests from a different workspace", () => {
		expect(
			insertRequestMatchesComposer(request(), {
				workspaceId: "workspace-2",
				sessionId: "session-1",
			}),
		).toBe(false);
	});

	it("matches session-targeted requests only for the requested session", () => {
		expect(
			insertRequestMatchesComposer(request({ sessionId: "session-2" }), {
				workspaceId: "workspace-1",
				sessionId: "session-2",
			}),
		).toBe(true);
		expect(
			insertRequestMatchesComposer(request({ sessionId: "session-2" }), {
				workspaceId: "workspace-1",
				sessionId: "session-1",
			}),
		).toBe(false);
	});
});
