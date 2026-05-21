/**
 * Track F3: cross-host workspace move dialog.
 *
 * Triggered from the sidebar's "Move to runtime" submenu when the
 * operator picks a remote target. Three-field form:
 *
 *   - Runtime: pre-filled, read-only label for context (the choice
 *     happened in the submenu).
 *   - Remote path: optional override for the workspace's location on
 *     the destination host. Empty / blank means "same path as locally"
 *     — fine for symmetric layouts (mac↔Linux with /home/d/code on
 *     both sides), required for asymmetric ones. When "Clone from
 *     current binding" is checked, the remote path is REQUIRED (we
 *     need somewhere to land the clone) and renders as such.
 *   - Clone toggle: when on, Helmor bundles the workspace on the
 *     source runtime via `workspace.bundle`, ships the bytes over
 *     the JSON-RPC channel, and `git clone`s on the destination.
 *     When off, the dialog only rebinds — the operator's expected
 *     to have copied files themselves.
 *
 * Pure UI: the dialog reports the operator's choices via
 * `onConfirm`; the parent owns the mutation (binding update vs full
 * clone). That split lets tests assert the form's contract without
 * needing IPC mocks.
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
	 * (or `null` if empty / whitespace). `cloneFromCurrent` reflects
	 * the toggle state; when true, the parent should run the bundle
	 * flow before flipping the binding. When false, the parent just
	 * rebinds.
	 */
	onConfirm: (args: {
		runtimeName: string;
		remotePath: string | null;
		cloneFromCurrent: boolean;
	}) => void;
};

export function MoveWorkspaceDialog({
	open,
	onOpenChange,
	runtimeName,
	workspaceId,
	onConfirm,
}: MoveWorkspaceDialogProps) {
	const [remotePath, setRemotePath] = useState("");
	const [cloneFromCurrent, setCloneFromCurrent] = useState(false);

	// Reset on open so a half-typed path or a stale toggle state
	// from a previous move doesn't leak into the next one.
	useEffect(() => {
		if (open) {
			setRemotePath("");
			setCloneFromCurrent(false);
		}
	}, [open]);

	const trimmedRemotePath = remotePath.trim();
	const cloneRequiresPath = cloneFromCurrent && trimmedRemotePath.length === 0;
	const submitDisabled = !runtimeName || cloneRequiresPath;

	const handleConfirm = () => {
		if (!runtimeName || cloneRequiresPath) return;
		onConfirm({
			runtimeName,
			remotePath: trimmedRemotePath.length === 0 ? null : trimmedRemotePath,
			cloneFromCurrent,
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
					<strong className="font-mono">{runtimeName ?? "—"}</strong>. With{" "}
					<em>Clone from current binding</em> off, Helmor expects the workspace
					to already exist on the remote at the path below — it does not copy
					files. With it on, Helmor bundles the source's <code>.git</code> over
					the wire and runs <code className="font-mono">git clone</code> on the
					destination.
				</DialogDescription>
				<div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
					<Label htmlFor="move-workspace-remote-path" className="text-xs">
						Remote path
					</Label>
					<Input
						id="move-workspace-remote-path"
						value={remotePath}
						onChange={(e) => setRemotePath(e.target.value)}
						placeholder={
							cloneFromCurrent
								? "Required: /home/dwork/code/foo"
								: "(Optional) /home/dwork/code/foo"
						}
						data-testid="move-workspace-remote-path"
					/>
				</div>
				<label
					className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-3 text-[11px] hover:bg-muted/50"
					data-testid="move-workspace-clone-toggle"
				>
					<input
						type="checkbox"
						className="mt-0.5"
						checked={cloneFromCurrent}
						onChange={(e) => setCloneFromCurrent(e.target.checked)}
						data-testid="move-workspace-clone-toggle-input"
					/>
					<span className="flex flex-col gap-0.5">
						<span className="font-medium">Clone from current binding</span>
						<span className="text-muted-foreground">
							Bundle the workspace's full repo state via{" "}
							<code className="font-mono">workspace.bundle</code> and{" "}
							<code className="font-mono">git clone</code> it onto the
							destination. Use when the destination doesn't already have the
							workspace. Bundles are capped at ~10 MiB —{" "}
							<code className="font-mono">rsync</code> separately for larger
							repos.
						</span>
					</span>
				</label>
				{!cloneFromCurrent ? (
					<p className="text-[10px] text-muted-foreground">
						Leave the path blank if the workspace sits at the same absolute path
						on the remote (the common macOS↔Linux case where{" "}
						<code className="font-mono">~/code/foo</code> exists on both sides).
					</p>
				) : (
					<p className="text-[10px] text-muted-foreground">
						The destination path is where Helmor will run{" "}
						<code className="font-mono">git clone</code>. It must not exist (or
						must be an empty directory).
					</p>
				)}
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
						disabled={submitDisabled}
						onClick={handleConfirm}
						data-testid="move-workspace-confirm"
					>
						{cloneFromCurrent ? "Clone + Move" : "Move"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
