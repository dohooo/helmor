import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExistingHelmorRepo } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";

import { HELMOR_UPSTREAM_SLUG } from "./constants";

type StepInputProps = {
	input: string;
	existing: ExistingHelmorRepo | null;
	/** False until `findExistingHelmorRepo` has resolved. Gates Quick fix
	 *  so a fast user can't bypass the "reuse local repo" optimization. */
	existingLoaded: boolean;
	githubConnected: boolean;
	/** True after the first "Create issue" click — show the confirm UI. */
	confirming: boolean;
	/** True while the issue API call is in flight. */
	sending: boolean;
	onInputChange: (input: string) => void;
	onCreateIssue: () => void;
	onCancelConfirm: () => void;
	onQuickFix: () => void;
	onOpenSettings: () => void;
};

export function StepInput({
	input,
	existing,
	existingLoaded,
	githubConnected,
	confirming,
	sending,
	onInputChange,
	onCreateIssue,
	onCancelConfirm,
	onQuickFix,
	onOpenSettings,
}: StepInputProps) {
	const { f } = useI18n();
	const hasInput = input.trim().length > 0;
	const canCreateIssue = hasInput && githubConnected;
	// Quick fix additionally waits for the existing-repo lookup so it
	// can take the reuse-local-repo branch when applicable.
	const canQuickFix = canCreateIssue && existingLoaded;

	return (
		<div className="flex flex-col gap-3">
			<Textarea
				id="feedback-input"
				value={input}
				onChange={(event) => onInputChange(event.target.value)}
				placeholder="Describe a bug, suggest an improvement, or ask a question."
				aria-label="Feedback"
				disabled={sending}
				className="field-sizing-fixed min-h-32"
			/>
			<div className="min-h-4 text-small text-muted-foreground">
				{!githubConnected ? (
					<>
						<I18nText source={"Connect GitHub in"} />{" "}
						<Button
							variant="link"
							size="xs"
							className="h-auto p-0 text-small"
							onClick={onOpenSettings}
						>
							Settings
						</Button>{" "}
						<I18nText source={"to send feedback."} />
					</>
				) : existing && !confirming ? (
					<I18nText source={"Will reuse your local Helmor repo."} />
				) : null}
			</div>
			<div className="mt-1 flex items-center justify-between gap-3">
				<p className="text-small text-muted-foreground">
					{confirming ? (
						<>
							{f("This will open an issue in {slug}.", {
								slug: HELMOR_UPSTREAM_SLUG,
							})}{" "}
							<I18nText source={"Confirm?"} />
						</>
					) : null}
				</p>
				<div className="flex shrink-0 items-center gap-2">
					{confirming ? (
						<>
							<Button
								variant="outline"
								size="sm"
								onClick={onCancelConfirm}
								disabled={sending}
							>
								Cancel
							</Button>
							<Button size="sm" onClick={onCreateIssue} disabled={sending}>
								{sending ? "Sending…" : "Confirm send"}
							</Button>
						</>
					) : (
						<>
							<Button
								variant="outline"
								size="sm"
								onClick={onCreateIssue}
								disabled={!canCreateIssue}
							>
								Create issue
							</Button>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="sm"
										onClick={onQuickFix}
										disabled={!canQuickFix}
									>
										Quick fix
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top" sideOffset={6}>
									Contribute to Helmor — super easy
								</TooltipContent>
							</Tooltip>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
