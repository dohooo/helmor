import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cloneRepositoryFromUrl, forkHelmorUpstream } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { describeUnknownError } from "@/lib/workspace-helpers";

import { HELMOR_UPSTREAM_SLUG } from "./constants";

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
	const { t } = useI18n();
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
					onFailed(describeUnknownError(error, t("feedbackFailedForkHelmor")));
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
				describeUnknownError(error, t("feedbackUnableOpenFolderPicker")),
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
			onFailed(describeUnknownError(error, t("feedbackFailedCloneRepository")));
		}
	};

	const handleRetryFork = () => {
		onPhaseChange("forking");
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-2 text-small leading-snug">
				{phase === "forking" ? (
					<>
						<LoaderCircle
							className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground"
							strokeWidth={2.1}
						/>
						<span className="text-muted-foreground">
							<I18nText source="forking" /> {HELMOR_UPSTREAM_SLUG}{" "}
							<I18nText source="githubAccount" />
						</span>
					</>
				) : forkedCloneUrl ? (
					<span className="text-muted-foreground">
						<I18nText source="forkReadyChooseWhereCloneMachine" />
					</span>
				) : (
					<span className="text-muted-foreground">
						<I18nText source="weLlForkUpstreamHelmorRepo" />
					</span>
				)}
			</div>

			{forkedCloneUrl ? (
				<div className="flex flex-col gap-1">
					<Label
						htmlFor="feedback-clone-location"
						className="text-small font-medium tracking-[-0.01em]"
					>
						<I18nText source="cloneLocation" />
					</Label>
					<div className="flex items-center gap-1.5">
						<Input
							id="feedback-clone-location"
							type="text"
							value={cloneDirectory ?? ""}
							readOnly
							placeholder="chooseFolder"
							className="h-7 text-ui"
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
							<I18nText source="browse" />
						</Button>
					</div>
				</div>
			) : null}

			{error ? (
				<p role="alert" className="text-small leading-snug text-destructive">
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
						<I18nText source="tryAgain" />
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
							{t("cloning")}
						</>
					) : (
						t("feedbackCloneToThisFolder")
					)}
				</Button>
			</div>
		</div>
	);
}
