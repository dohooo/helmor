import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExistingHelmorRepo } from "@/lib/api";

import { HELMOR_UPSTREAM_SLUG } from "./constants";

type StepInputProps = {
	input: string;
	existing: ExistingHelmorRepo | null;
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
	githubConnected,
	confirming,
	sending,
	onInputChange,
	onCreateIssue,
	onCancelConfirm,
	onQuickFix,
	onOpenSettings,
}: StepInputProps) {
	const canSubmit = input.trim().length > 0 && githubConnected;

	return (
		<div className="flex flex-col gap-3">
			<Textarea
				value={input}
				onChange={(event) => onInputChange(event.target.value)}
				placeholder="Describe a bug, suggest an improvement, or ask a question."
				autoFocus
				aria-label="Feedback"
				disabled={sending}
				className="min-h-32"
			/>
			{!githubConnected ? (
				<p className="text-xs text-muted-foreground">
					Connect GitHub in{" "}
					<Button
						variant="link"
						size="xs"
						className="h-auto p-0 text-xs"
						onClick={onOpenSettings}
					>
						Settings
					</Button>{" "}
					to send feedback.
				</p>
			) : null}
			{existing && githubConnected && !confirming ? (
				<p className="text-xs text-muted-foreground">
					Will reuse your local helmor repo.
				</p>
			) : null}
			<div className="mt-1 flex items-center justify-between gap-3">
				<p className="text-xs text-muted-foreground">
					{confirming
						? `This will open an issue in ${HELMOR_UPSTREAM_SLUG}. Confirm?`
						: null}
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
								disabled={!canSubmit}
							>
								Create issue
							</Button>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button size="sm" onClick={onQuickFix} disabled={!canSubmit}>
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
