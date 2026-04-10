import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { renderWithProviders } from "@/test/render-with-providers";
import { AppendContextButton } from "./append-context-button";

describe("AppendContextButton", () => {
	it("normalizes a single custom-tag payload into a composer insert request", async () => {
		const user = userEvent.setup();
		const insertIntoComposer = vi.fn();
		const pushToast = vi.fn();

		renderWithProviders(
			<WorkspaceToastProvider value={pushToast}>
				<ComposerInsertProvider value={insertIntoComposer}>
					<AppendContextButton
						subjectLabel="Checks"
						getPayload={async () => ({
							target: { workspaceId: "workspace-1" },
							label: "CI failure",
							submitText: "full log output",
							key: "check-1",
						})}
					/>
				</ComposerInsertProvider>
			</WorkspaceToastProvider>,
		);

		await user.click(
			screen.getByRole("button", { name: "Append Checks to composer" }),
		);

		await waitFor(() => {
			expect(insertIntoComposer).toHaveBeenCalledWith({
				target: { workspaceId: "workspace-1" },
				items: [
					{
						kind: "custom-tag",
						label: "CI failure",
						submitText: "full log output",
						key: "check-1",
					},
				],
				behavior: "append",
			});
		});
		expect(pushToast).not.toHaveBeenCalled();
	});

	it("passes through a full insert request payload unchanged", async () => {
		const user = userEvent.setup();
		const insertIntoComposer = vi.fn();

		renderWithProviders(
			<WorkspaceToastProvider value={vi.fn()}>
				<ComposerInsertProvider value={insertIntoComposer}>
					<AppendContextButton
						subjectLabel="Selection"
						getPayload={async () => ({
							target: { workspaceId: "workspace-1", sessionId: "session-1" },
							items: [
								{ kind: "text", text: "prefix" },
								{
									kind: "custom-tag",
									label: "Context",
									submitText: "expanded context",
								},
							],
							behavior: "append",
						})}
					/>
				</ComposerInsertProvider>
			</WorkspaceToastProvider>,
		);

		await user.click(
			screen.getByRole("button", { name: "Append Selection to composer" }),
		);

		await waitFor(() => {
			expect(insertIntoComposer).toHaveBeenCalledWith({
				target: { workspaceId: "workspace-1", sessionId: "session-1" },
				items: [
					{ kind: "text", text: "prefix" },
					{
						kind: "custom-tag",
						label: "Context",
						submitText: "expanded context",
					},
				],
				behavior: "append",
			});
		});
	});
});
