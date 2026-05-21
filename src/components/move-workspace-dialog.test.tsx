import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveWorkspaceDialog } from "./move-workspace-dialog";

describe("MoveWorkspaceDialog", () => {
	afterEach(() => {
		cleanup();
	});

	it("fires onConfirm with the trimmed remote path", async () => {
		const onConfirm = vi.fn();
		const user = userEvent.setup();
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={onConfirm}
			/>,
		);
		await user.type(
			screen.getByTestId("move-workspace-remote-path"),
			"  /home/d/code/foo  ",
		);
		await user.click(screen.getByTestId("move-workspace-confirm"));
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
			runtimeName: "dev.box",
			remotePath: "/home/d/code/foo",
		});
	});

	it("collapses an empty / whitespace-only path to null", async () => {
		const onConfirm = vi.fn();
		const user = userEvent.setup();
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={onConfirm}
			/>,
		);
		// Don't type anything — empty input means "no override".
		await user.click(screen.getByTestId("move-workspace-confirm"));
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
			runtimeName: "dev.box",
			remotePath: null,
		});
	});

	it("disables Confirm when there's no runtime to move to", () => {
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName={null}
				workspaceId="ws-1"
				onConfirm={() => {}}
			/>,
		);
		expect(screen.getByTestId("move-workspace-confirm")).toBeDisabled();
	});

	it("clears the path input when reopened for a different runtime", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={() => {}}
			/>,
		);
		await user.type(
			screen.getByTestId("move-workspace-remote-path"),
			"leftover-path",
		);
		// Close + reopen for a different runtime.
		rerender(
			<MoveWorkspaceDialog
				open={false}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={() => {}}
			/>,
		);
		rerender(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="staging"
				workspaceId="ws-2"
				onConfirm={() => {}}
			/>,
		);
		const input = await screen.findByTestId("move-workspace-remote-path");
		expect((input as HTMLInputElement).value).toBe("");
	});

	it("cancel button closes the dialog without firing onConfirm", async () => {
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={onOpenChange}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={onConfirm}
			/>,
		);
		await user.click(screen.getByTestId("move-workspace-cancel"));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
