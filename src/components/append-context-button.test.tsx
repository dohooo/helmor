import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { renderWithProviders } from "@/test/render-with-providers";
import { AppendContextButton } from "./append-context-button";

afterEach(() => {
	cleanup();
});

describe("AppendContextButton", () => {
	it("inserts short payloads as plain text", async () => {
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
				items: [{ kind: "text", text: "full log output" }],
				behavior: "append",
			});
		});
		expect(pushToast).not.toHaveBeenCalled();
	});

	it("normalizes long payloads into preview badges", async () => {
		const user = userEvent.setup();
		const insertIntoComposer = vi.fn();
		// 22 chars per line × 25 = 550 chars, above the composer preview threshold (500).
		const longCode = "const failure = true;\n".repeat(25);

		renderWithProviders(
			<WorkspaceToastProvider value={vi.fn()}>
				<ComposerInsertProvider value={insertIntoComposer}>
					<AppendContextButton
						subjectLabel="Checks"
						getPayload={async () => ({
							target: { workspaceId: "workspace-1" },
							label: "CI failure",
							submitText: longCode,
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
						submitText: longCode,
						key: "check-1",
						preview: {
							kind: "code",
							title: "CI failure",
							language: "ts",
							code: longCode,
						},
					},
				],
				behavior: "append",
			});
		});
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
