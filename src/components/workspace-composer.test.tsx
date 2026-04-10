import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient } from "@/lib/query-client";

vi.mock("./composer-editor/plugins/file-mention-plugin", () => ({
	FileMentionPlugin: () => null,
}));

vi.mock("./composer-editor/plugins/slash-command-plugin", () => ({
	SlashCommandPlugin: () => null,
}));

import { WorkspaceComposer } from "./workspace-composer";

const MODEL_SECTIONS = [
	{
		id: "claude",
		label: "Claude",
		options: [
			{
				id: "opus-1m",
				provider: "claude",
				label: "Opus 4.6 1M",
				cliModel: "opus-1m",
				badge: null,
			},
		],
	},
] satisfies import("@/lib/api").AgentModelSection[];

describe("WorkspaceComposer", () => {
	it("renders custom tag insertions as badges and expands them on submit", async () => {
		const queryClient = createHelmorQueryClient();
		const handleSubmit = vi.fn();
		const handleConsumed = vi.fn();

		render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceComposer
					contextKey="session:session-1"
					onSubmit={handleSubmit}
					disabled={false}
					submitDisabled={false}
					sending={false}
					selectedModelId="opus-1m"
					modelSections={MODEL_SECTIONS}
					onSelectModel={vi.fn()}
					provider="claude"
					effortLevel="high"
					onSelectEffort={vi.fn()}
					permissionMode="acceptEdits"
					onTogglePlanMode={vi.fn()}
					restoreImages={[]}
					restoreFiles={[]}
					restoreCustomTags={[]}
					pendingInsertRequests={[
						{
							id: "insert-1",
							workspaceId: "workspace-1",
							sessionId: "session-1",
							behavior: "append",
							createdAt: 0,
							items: [
								{
									kind: "custom-tag",
									key: "tag-1",
									label: "Requirements",
									submitText:
										"Please implement the full requirements document.",
								},
							],
						},
					]}
					onPendingInsertRequestsConsumed={handleConsumed}
				/>
			</QueryClientProvider>,
		);

		await screen.findByText("Requirements");
		await waitFor(() => {
			expect(handleConsumed).toHaveBeenCalledWith(["insert-1"]);
			expect(screen.getByLabelText("Send")).toBeEnabled();
		});

		fireEvent.click(screen.getByLabelText("Send"));

		expect(handleSubmit).toHaveBeenCalledWith(
			"Please implement the full requirements document.",
			[],
			[],
			[
				{
					id: "tag-1",
					label: "Requirements",
					submitText: "Please implement the full requirements document.",
				},
			],
		);
	});
});
