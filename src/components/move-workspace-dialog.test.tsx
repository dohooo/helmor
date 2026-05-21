import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveWorkspaceDialog } from "./move-workspace-dialog";

describe("MoveWorkspaceDialog", () => {
	afterEach(() => {
		cleanup();
	});

	it("fires onConfirm with the trimmed remote path and cloneFromCurrent=false by default", async () => {
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
			cloneFromCurrent: false,
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
			cloneFromCurrent: false,
		});
	});

	it("propagates cloneFromCurrent=true when the toggle is checked", async () => {
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
			"/home/dwork/code/foo",
		);
		await user.click(screen.getByTestId("move-workspace-clone-toggle-input"));
		await user.click(screen.getByTestId("move-workspace-confirm"));
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
			runtimeName: "dev.box",
			remotePath: "/home/dwork/code/foo",
			cloneFromCurrent: true,
		});
	});

	it("disables Confirm when cloneFromCurrent is checked but no path is provided", async () => {
		const user = userEvent.setup();
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={() => {}}
			/>,
		);
		// Initially enabled (toggle off).
		expect(screen.getByTestId("move-workspace-confirm")).toBeEnabled();
		// Check the toggle without filling in a path — submit must
		// disable because clone needs a destination.
		await user.click(screen.getByTestId("move-workspace-clone-toggle-input"));
		expect(screen.getByTestId("move-workspace-confirm")).toBeDisabled();
		// Type a path → re-enabled.
		await user.type(screen.getByTestId("move-workspace-remote-path"), "/dest");
		expect(screen.getByTestId("move-workspace-confirm")).toBeEnabled();
	});

	it("changes the confirm button label to 'Clone + Move' when toggle is on", async () => {
		const user = userEvent.setup();
		render(
			<MoveWorkspaceDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
				workspaceId="ws-1"
				onConfirm={() => {}}
			/>,
		);
		expect(screen.getByTestId("move-workspace-confirm")).toHaveTextContent(
			"Move",
		);
		await user.click(screen.getByTestId("move-workspace-clone-toggle-input"));
		expect(screen.getByTestId("move-workspace-confirm")).toHaveTextContent(
			"Clone + Move",
		);
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
