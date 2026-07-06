import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
	PrepareWorkspaceResponse,
	WorkspaceDetail,
	WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { seedCreatedWorkspaceCaches } from "./seed-created-workspace";

const WORKSPACE_ID = "ws-new";
const SESSION_ID = "session-new";

function makePrepared(
	overrides: Partial<PrepareWorkspaceResponse> = {},
): PrepareWorkspaceResponse {
	return {
		workspaceId: WORKSPACE_ID,
		initialSessionId: SESSION_ID,
		repoId: "repo-1",
		repoName: "helmor",
		directoryName: "helmor-fix",
		branch: "dohooo/fix",
		defaultBranch: "main",
		state: "initializing",
		repoScripts: { setupScript: null, verifyScript: null },
		workingDirectory: null,
		branchIntent: "from_branch",
		...overrides,
	} as PrepareWorkspaceResponse;
}

function threadKey(sessionId: string) {
	return [...helmorQueryKeys.sessionMessages(sessionId), "thread"];
}

describe("seedCreatedWorkspaceCaches", () => {
	it("seeds all three caches the cached display fast path requires (build mode)", () => {
		const queryClient = new QueryClient();
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared: makePrepared(),
			mode: "worktree",
			workingDirectory: null,
		});

		const detail = queryClient.getQueryData<WorkspaceDetail>(
			helmorQueryKeys.workspaceDetail(WORKSPACE_ID),
		);
		expect(detail).toMatchObject({
			id: WORKSPACE_ID,
			repoId: "repo-1",
			repoName: "helmor",
			state: "initializing",
			mode: "worktree",
			activeSessionId: SESSION_ID,
			sessionCount: 1,
		});

		const sessions = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions(WORKSPACE_ID),
		);
		expect(sessions).toHaveLength(1);
		expect(sessions?.[0]).toMatchObject({ id: SESSION_ID, active: true });

		expect(queryClient.getQueryData(threadKey(SESSION_ID))).toEqual([]);
	});

	it("seeds the chat synthetic shape (mode gate stability)", () => {
		const queryClient = new QueryClient();
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared: makePrepared({ repoId: "", repoName: "", state: "ready" }),
			mode: "chat",
			workingDirectory: "/tmp/chats/ws-new",
		});

		const detail = queryClient.getQueryData<WorkspaceDetail>(
			helmorQueryKeys.workspaceDetail(WORKSPACE_ID),
		);
		expect(detail).toMatchObject({
			mode: "chat",
			state: "ready",
			title: "New chat",
			repoName: "Chats",
			rootPath: "/tmp/chats/ws-new",
			activeSessionId: SESSION_ID,
		});
	});

	it("never clobbers an already-cached authoritative detail", () => {
		const queryClient = new QueryClient();
		const authoritative = { id: WORKSPACE_ID, title: "Real title" };
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail(WORKSPACE_ID),
			authoritative,
		);
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared: makePrepared(),
			mode: "worktree",
			workingDirectory: null,
		});
		const detail = queryClient.getQueryData<WorkspaceDetail>(
			helmorQueryKeys.workspaceDetail(WORKSPACE_ID),
		);
		// `existing ?? synthetic` semantics — but the session seeder is
		// allowed to bump the active-session fields on the existing detail.
		expect(detail?.title).toBe("Real title");
		expect(detail?.activeSessionId).toBe(SESSION_ID);
	});

	// R3-C review requirement: the classic seeded-cache trap — when the
	// AUTHORITATIVE list lands (real fetch replacing the synthetic seed),
	// there must be no duplicate row and no identity churn for the session
	// the panel is already rendering (tabs key off `session.id`; React
	// Query's structural sharing keeps deep-equal rows reference-stable).
	it("authoritative replacement: no duplicate rows, id-stable, structurally shared", () => {
		const queryClient = new QueryClient();
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared: makePrepared(),
			mode: "worktree",
			workingDirectory: null,
		});
		const seeded = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions(WORKSPACE_ID),
		);
		expect(seeded).toHaveLength(1);
		const seededRow = seeded?.[0] as WorkspaceSessionSummary;

		// The real fetch resolves with the SAME session id but authoritative
		// fields (real title, timestamps). Landing it through setQueryData
		// exercises the same replaceEqualDeep path a queryFn resolution uses.
		const authoritativeRow: WorkspaceSessionSummary = {
			...seededRow,
			title: "Fix the flaky test",
			updatedAt: "2026-07-06T12:00:00.000Z",
		};
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions(WORKSPACE_ID), [
			authoritativeRow,
		]);

		const replaced = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions(WORKSPACE_ID),
		);
		// No duplicates: exactly one row, same id → keyed tab does not remount.
		expect(replaced).toHaveLength(1);
		expect(replaced?.[0]?.id).toBe(SESSION_ID);
		expect(replaced?.[0]?.title).toBe("Fix the flaky test");

		// Structural sharing: landing a deep-equal list keeps the previous
		// references (zero re-render churn when the refetch confirms the seed).
		queryClient.setQueryData(helmorQueryKeys.workspaceSessions(WORKSPACE_ID), [
			{ ...authoritativeRow },
		]);
		const confirmed = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions(WORKSPACE_ID),
		);
		expect(confirmed).toBe(replaced);
		expect(confirmed?.[0]).toBe(replaced?.[0]);
	});

	it("re-seeding the same session is idempotent (no duplicate rows)", () => {
		const queryClient = new QueryClient();
		const prepared = makePrepared();
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared,
			mode: "worktree",
			workingDirectory: null,
		});
		seedCreatedWorkspaceCaches({
			queryClient,
			prepared,
			mode: "worktree",
			workingDirectory: null,
		});
		const sessions = queryClient.getQueryData<WorkspaceSessionSummary[]>(
			helmorQueryKeys.workspaceSessions(WORKSPACE_ID),
		);
		expect(sessions).toHaveLength(1);
	});
});
