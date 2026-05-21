/**
 * Track F3: cross-host workspace move dialog.
 *
 * Triggered from the sidebar's "Move to runtime" submenu when the
 * operator picks a remote target. Two-field form:
 *
 *   - Runtime: pre-filled, read-only label for context (the choice
 *     happened in the submenu).
 *   - Remote path: optional override for the workspace's location on
 *     the destination host. Empty / blank means "same path as locally"
 *     — fine for symmetric layouts (mac↔Linux with /home/d/code on
 *     both sides), required for asymmetric ones.
 *
 * Pure binding-update flow: this dialog never shells out to git. The
 * destination is assumed to already have the workspace at the chosen
 * path (operator dragged a checkout there, ran rsync, etc.). A
 * future iteration can layer a "Clone from current binding" toggle
 * on top.
 *
 * For the local target the caller skips the dialog entirely and
 * clears the binding directly — there's nothing to ask the operator
 * about.
 */

import { Network, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type MoveWorkspaceDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Runtime the workspace will be moved to. `null` closes the
	 * dialog — the parent controls visibility via this value. */
	runtimeName: string | null;
	/** Workspace ID being moved. Surfaced in the description so the
	 * operator can confirm they picked the right row. */
	workspaceId: string | null;
	/**
	 * Fired when the user confirms. `remotePath` is the trimmed path
	 * (or `null` if empty / whitespace). The caller is responsible for
	 * triggering the actual binding update — keeping the mutation out
	 * of this component lets tests assert the form's contract without
	 * depending on the IPC mock.
	 */
	onConfirm: (args: { runtimeName: string; remotePath: string | null }) => void;
};

export function MoveWorkspaceDialog({
	open,
	onOpenChange,
	runtimeName,
	workspaceId,
	onConfirm,
}: MoveWorkspaceDialogProps) {
	const [remotePath, setRemotePath] = useState("");

	// Reset the input each time the dialog opens, so a half-typed
	// path from a previous move doesn't leak into the next one.
	useEffect(() => {
		if (open) setRemotePath("");
	}, [open]);

	const handleConfirm = () => {
		if (!runtimeName) return;
		const trimmed = remotePath.trim();
		onConfirm({
			runtimeName,
			remotePath: trimmed.length === 0 ? null : trimmed,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="w-[min(85vw,480px)] max-w-[480px] gap-3 p-5"
				data-testid="move-workspace-dialog"
			>
				<div className="flex items-center justify-between">
					<DialogTitle className="flex items-center gap-2 text-sm font-semibold">
						<Network className="size-3.5" />
						Move to {runtimeName ?? "…"}
					</DialogTitle>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={() => onOpenChange(false)}
						aria-label="Close move-workspace dialog"
					>
						<X className="size-3.5" />
					</Button>
				</div>
				<DialogDescription className="text-[11px] text-muted-foreground">
					Rebinds workspace{" "}
					<strong className="font-mono">{workspaceId ?? "—"}</strong> to{" "}
					<strong className="font-mono">{runtimeName ?? "—"}</strong>. Helmor
					expects the workspace to already exist on the remote at the path below
					— it does not copy files for you.
				</DialogDescription>
				<div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
					<Label htmlFor="move-workspace-remote-path" className="text-xs">
						Remote path
					</Label>
					<Input
						id="move-workspace-remote-path"
						value={remotePath}
						onChange={(e) => setRemotePath(e.target.value)}
						placeholder="(Optional) /home/dwork/code/foo"
						data-testid="move-workspace-remote-path"
					/>
				</div>
				<p className="text-[10px] text-muted-foreground">
					Leave blank if the workspace sits at the same absolute path on the
					remote (the common macOS↔Linux case where{" "}
					<code className="font-mono">~/code/foo</code> exists on both sides).
				</p>
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
						data-testid="move-workspace-cancel"
					>
						Cancel
					</Button>
					<Button
						size="sm"
						disabled={!runtimeName}
						onClick={handleConfirm}
						data-testid="move-workspace-confirm"
					>
						Move
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
