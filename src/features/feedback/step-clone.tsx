import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cloneRepositoryFromUrl, forkHelmorUpstream } from "@/lib/api";
import { describeUnknownError } from "@/lib/workspace-helpers";

type ClonePhase = "idle" | "forking" | "picking" | "cloning";

type StepCloneProps = {
	phase: ClonePhase;
	forkedCloneUrl: string | null;
	cloneDirectory: string | null;
	error: string | null;
	onPhaseChange: (phase: ClonePhase) => void;
	onForkSucceeded: (cloneUrl: string) => void;
	onDirectorySelected: (directory: string) => void;
	onFailed: (message: string) => void;
	onCloneSucceeded: (repoId: string) => void;
};

export function StepClone({
	phase,
	forkedCloneUrl,
	cloneDirectory,
	error,
	onPhaseChange,
	onForkSucceeded,
	onDirectorySelected,
	onFailed,
	onCloneSucceeded,
}: StepCloneProps) {
	// Kick off the fork as soon as the step mounts. Reducer seeds phase =
	// "forking" on entry; if we're back in "idle" after a failure the user
	// can hit "Try again" manually.
	useEffect(() => {
		if (phase !== "forking" || forkedCloneUrl) {
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const fork = await forkHelmorUpstream();
				if (!cancelled) {
					onForkSucceeded(fork.cloneUrl);
				}
			} catch (error) {
				if (!cancelled) {
					onFailed(
						describeUnknownError(error, "Failed to fork helmor on GitHub."),
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [phase, forkedCloneUrl, onForkSucceeded, onFailed]);

	const handleBrowse = async () => {
		try {
			const selection = await openDialog({
				directory: true,
				multiple: false,
				defaultPath: cloneDirectory ?? undefined,
			});
			const selected = Array.isArray(selection) ? selection[0] : selection;
			if (selected) {
				onDirectorySelected(selected);
			}
		} catch (error) {
			onFailed(
				describeUnknownError(error, "Unable to open the folder picker."),
			);
		}
	};

	const handleClone = async () => {
		if (!forkedCloneUrl || !cloneDirectory) return;
		onPhaseChange("cloning");
		try {
			const response = await cloneRepositoryFromUrl({
				gitUrl: forkedCloneUrl,
				cloneDirectory,
			});
			onCloneSucceeded(response.repositoryId);
		} catch (error) {
			onFailed(describeUnknownError(error, "Failed to clone repository."));
		}
	};

	const handleRetryFork = () => {
		onPhaseChange("forking");
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-2 text-[12px] leading-snug">
				{phase === "forking" ? (
					<>
						<LoaderCircle
							className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
							strokeWidth={2.1}
						/>
						<span className="text-muted-foreground">
							Forking Dohoo/helmor to your GitHub account…
						</span>
					</>
				) : forkedCloneUrl ? (
					<span className="text-muted-foreground">
						Fork ready. Choose where to clone it on your machine.
					</span>
				) : (
					<span className="text-muted-foreground">
						We'll fork the upstream Helmor repo into your GitHub account.
					</span>
				)}
			</div>

			{forkedCloneUrl ? (
				<div className="flex flex-col gap-1">
					<Label
						htmlFor="feedback-clone-location"
						className="text-[12px] font-medium tracking-[-0.01em]"
					>
						Clone location
					</Label>
					<div className="flex items-center gap-1.5">
						<Input
							id="feedback-clone-location"
							type="text"
							value={cloneDirectory ?? ""}
							readOnly
							placeholder="Choose a folder…"
							className="h-7 text-[13px] md:text-[13px]"
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								void handleBrowse();
							}}
							disabled={phase === "cloning"}
						>
							<FolderOpen data-icon="inline-start" />
							Browse…
						</Button>
					</div>
				</div>
			) : null}

			{error ? (
				<p role="alert" className="text-[12px] leading-snug text-destructive">
					{error}
				</p>
			) : null}

			<div className="flex items-center justify-end gap-2 pt-0.5">
				{phase === "idle" && error ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleRetryFork}
					>
						Try again
					</Button>
				) : null}
				<Button
					type="button"
					size="sm"
					onClick={() => {
						void handleClone();
					}}
					disabled={
						!forkedCloneUrl ||
						!cloneDirectory ||
						phase === "cloning" ||
						phase === "forking"
					}
				>
					{phase === "cloning" ? (
						<>
							<LoaderCircle
								data-icon="inline-start"
								className="animate-spin"
								strokeWidth={2.1}
							/>
							Cloning…
						</>
					) : (
						"Clone to this folder"
					)}
				</Button>
			</div>
		</div>
	);
}
