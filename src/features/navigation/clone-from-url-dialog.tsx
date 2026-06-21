import { open } from "@tauri-apps/plugin-dialog";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { I18nText, useI18n } from "@/lib/i18n";
import { isTeamModeActive } from "@/lib/team-mode";
import { describeUnknownError } from "@/lib/workspace-helpers";

// In team mode the clone runs in the cloud sandbox, where the serve subprocess
// cannot write the persistent volume (/workspace is EROFS to serve, /home is
// ENOTSUP). So the Worker intercepts this clone, runs it via the Sandbox SDK's
// gitCheckout into the persistent /workspace, then registers the repo through
// the existing add_repository_from_local_path RPC (see cloud/src/index.ts
// `handleTeamClone`). Default the location to /workspace and drop the local
// folder picker — it can't see the container FS.
const CONTAINER_WORK_ROOT = "/workspace";

type SubmitArgs = {
	gitUrl: string;
	cloneDirectory: string;
};

type CloneFromUrlDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultCloneDirectory: string | null;
	onSubmit: (args: SubmitArgs) => Promise<void>;
};

export function CloneFromUrlDialog({
	open: isOpen,
	onOpenChange,
	defaultCloneDirectory,
	onSubmit,
}: CloneFromUrlDialogProps) {
	const [gitUrl, setGitUrl] = useState("");
	const [cloneDirectory, setCloneDirectory] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const { t } = useI18n();
	// Track whether the user has explicitly edited the location so the default
	// only seeds the field once per open session — reopening after a manual
	// change shouldn't wipe their choice.
	const cloneDirectoryTouchedRef = useRef(false);
	const teamMode = isTeamModeActive();

	useEffect(() => {
		if (!isOpen) {
			return;
		}
		setIsSubmitting(false);
		setErrorMessage(null);
		if (!cloneDirectoryTouchedRef.current) {
			setCloneDirectory(
				teamMode ? CONTAINER_WORK_ROOT : (defaultCloneDirectory ?? ""),
			);
		}
	}, [isOpen, defaultCloneDirectory, teamMode]);

	const handleBrowse = useCallback(async () => {
		try {
			const selection = await open({
				directory: true,
				multiple: false,
				defaultPath: cloneDirectory || defaultCloneDirectory || undefined,
			});
			const selected = Array.isArray(selection) ? selection[0] : selection;
			if (selected) {
				cloneDirectoryTouchedRef.current = true;
				setCloneDirectory(selected);
			}
		} catch (error) {
			setErrorMessage(
				describeUnknownError(error, "Unable to open the folder picker."),
			);
		}
	}, [cloneDirectory, defaultCloneDirectory]);

	const trimmedUrl = gitUrl.trim();
	const trimmedDirectory = cloneDirectory.trim();
	const canSubmit =
		trimmedUrl.length > 0 && trimmedDirectory.length > 0 && !isSubmitting;

	const handleSubmit = useCallback(async () => {
		if (!canSubmit) {
			return;
		}
		setIsSubmitting(true);
		setErrorMessage(null);
		try {
			await onSubmit({
				gitUrl: trimmedUrl,
				cloneDirectory: trimmedDirectory,
			});
			setGitUrl("");
			setCloneDirectory("");
			cloneDirectoryTouchedRef.current = false;
			onOpenChange(false);
		} catch (error) {
			setErrorMessage(
				describeUnknownError(error, "Unable to clone repository."),
			);
		} finally {
			setIsSubmitting(false);
		}
	}, [canSubmit, onOpenChange, onSubmit, trimmedDirectory, trimmedUrl]);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(nextOpen) => {
				if (isSubmitting && !nextOpen) {
					return;
				}
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent className="gap-3 p-4 sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-ui font-medium tracking-[-0.01em]">
						<I18nText source="cloneFromUrl" />
					</DialogTitle>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void handleSubmit();
					}}
					className="flex flex-col gap-3"
				>
					<div className="flex flex-col gap-1">
						<Label
							htmlFor="clone-git-url"
							className="text-small font-medium tracking-[-0.01em]"
						>
							<I18nText source="gitUrl" />
						</Label>
						<Input
							id="clone-git-url"
							type="text"
							value={gitUrl}
							onChange={(event) => setGitUrl(event.target.value)}
							placeholder="https://github.com/user/repo.git"
							autoFocus
							autoComplete="off"
							autoCorrect="off"
							spellCheck={false}
							disabled={isSubmitting}
							className="h-7 text-ui"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label
							htmlFor="clone-location"
							className="text-small font-medium tracking-[-0.01em]"
						>
							<I18nText source="cloneLocation" />
						</Label>
						<div className="flex items-center gap-1.5">
							<Input
								id="clone-location"
								type="text"
								value={cloneDirectory}
								onChange={(event) => {
									cloneDirectoryTouchedRef.current = true;
									setCloneDirectory(event.target.value);
								}}
								autoComplete="off"
								autoCorrect="off"
								spellCheck={false}
								disabled={isSubmitting}
								className="h-7 text-ui"
							/>
							{teamMode ? null : (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										void handleBrowse();
									}}
									disabled={isSubmitting}
								>
									<I18nText source="browse" />
								</Button>
							)}
						</div>
						{teamMode ? (
							<p className="text-muted-foreground text-small leading-snug">
								Path inside the cloud sandbox.
							</p>
						) : null}
					</div>
					{errorMessage ? (
						<p
							role="alert"
							className="text-destructive text-small leading-snug"
						>
							{errorMessage}
						</p>
					) : null}
					<div className="flex justify-end pt-0.5">
						<Button type="submit" size="sm" disabled={!canSubmit}>
							{isSubmitting ? (
								<>
									<LoaderCircle className="animate-spin" strokeWidth={2.1} />
									{t("cloning")}
								</>
							) : (
								t("navCloneRepository")
							)}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
