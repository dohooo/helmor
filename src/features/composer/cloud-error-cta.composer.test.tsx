import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createHelmorQueryClient } from "@/lib/query-client";

// Composer draft plugins call Tauri IPC on mount; stub it like index.test.tsx.
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "list_session_drafts") return [];
		if (cmd === "set_session_draft") return undefined;
		return undefined;
	}),
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { WorkspaceComposer } from "./index";

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.7 1M",
				cliModel: "opus-1m",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
		],
	},
] satisfies import("@/lib/api").AgentModelSection[];

function enableTeamMode(): void {
	localStorage.setItem("helmor.team.url", "https://team.example.com");
	localStorage.setItem("helmor.team.token", "hlm_secret");
	localStorage.setItem("helmor.team.mode", "1");
}

function renderComposer(sendError: string | null) {
	const queryClient = createHelmorQueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={0}>
				<WorkspaceComposer
					contextKey="session:session-cta"
					onSubmit={vi.fn()}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="bypassPermissions"
					onChangePermissionMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					sendError={sendError}
				/>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

describe("WorkspaceComposer — cloud-error recovery CTA", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows a Re-authorize button on a team auth error and opens Team settings", () => {
		enableTeamMode();
		const dispatchSpy = vi.spyOn(window, "dispatchEvent");
		renderComposer("Request failed: Unauthorized");

		const button = screen.getByRole("button", { name: "Re-authorize" });
		fireEvent.click(button);

		const openEvent = dispatchSpy.mock.calls
			.map(([event]) => event)
			.find(
				(event): event is CustomEvent =>
					event instanceof CustomEvent && event.type === "helmor:open-settings",
			);
		expect(openEvent).toBeDefined();
		expect((openEvent as CustomEvent).detail).toEqual({ section: "team" });
	});

	it("shows a View Team settings button on a team billing error", () => {
		enableTeamMode();
		renderComposer("Agent SDK credit balance is too low");

		expect(
			screen.getByRole("button", { name: "View Team settings" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Re-authorize" }),
		).not.toBeInTheDocument();
	});

	it("renders the plain error box (no CTA) for an unrelated team error", () => {
		enableTeamMode();
		renderComposer("Connection reset by peer");

		expect(screen.getByText("Connection reset by peer")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Re-authorize" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "View Team settings" }),
		).not.toBeInTheDocument();
	});

	it("never shows a CTA in single-user mode, even for an auth error", () => {
		// team mode NOT enabled
		renderComposer("Request failed: Unauthorized");

		expect(
			screen.getByText("Request failed: Unauthorized"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Re-authorize" }),
		).not.toBeInTheDocument();
	});
});
