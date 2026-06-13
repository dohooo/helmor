/**
 * Smoke test for the Automations surface. The IPC layer is mocked via
 * `vi.mock("@/lib/api", ...)` (same pattern as the panel/banner tests) so
 * no Tauri runtime is needed. Guards the list rendering contract: a row
 * shows the automation title plus its schedule labels.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";

const apiMocks = vi.hoisted(() => ({
	listAutomations: vi.fn(),
	loadWorkspaceGroups: vi.fn(),
	loadWorkspaceSessions: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		listAutomations: apiMocks.listAutomations,
		loadWorkspaceGroups: apiMocks.loadWorkspaceGroups,
		loadWorkspaceSessions: apiMocks.loadWorkspaceSessions,
	};
});

import { AutomationsSurface } from "./index";

function sampleAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "auto-1",
		title: "Nightly crash sweep",
		prompt: "Look for new crashes in Sentry and triage them",
		runsIn: "chat",
		sessionId: "session-1",
		workspaceId: "ws-1",
		schedule: { kind: "hourly" },
		status: "active",
		nextRunAt: "2026-06-11T12:00:00Z",
		lastRunAt: null,
		createdAt: "2026-06-01T00:00:00Z",
		updatedAt: "2026-06-01T00:00:00Z",
		...overrides,
	};
}

function renderSurface() {
	return render(
		<QueryClientProvider client={createHelmorQueryClient()}>
			<AutomationsSurface onOpenSession={vi.fn()} onCreateViaChat={vi.fn()} />
		</QueryClientProvider>,
	);
}

describe("AutomationsSurface", () => {
	beforeEach(() => {
		apiMocks.listAutomations.mockReset();
		apiMocks.loadWorkspaceGroups.mockResolvedValue([]);
		apiMocks.loadWorkspaceSessions.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
	});

	it("renders a row with title, schedule summary and interval label", async () => {
		apiMocks.listAutomations.mockResolvedValue([sampleAutomation()]);

		renderSurface();

		expect(await screen.findByText("Nightly crash sweep")).toBeInTheDocument();
		// "Hourly" appears twice: in the muted "<summary> · <prompt>" line and
		// as the right-aligned interval label.
		expect(screen.getAllByText(/Hourly/).length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText(/Look for new crashes/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Create via chat" }),
		).toBeInTheDocument();
	});

	it("shows the empty state when there are no automations", async () => {
		apiMocks.listAutomations.mockResolvedValue([]);

		renderSurface();

		expect(
			await screen.findByRole("button", { name: "Create automation" }),
		).toBeInTheDocument();
	});
});
