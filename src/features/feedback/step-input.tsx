import { Hammer, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExistingHelmorWorkspace } from "@/lib/api";

type StepInputProps = {
	input: string;
	error: string | null;
	existing: ExistingHelmorWorkspace | null;
	githubConnected: boolean;
	onInputChange: (input: string) => void;
	onCreateIssue: () => void;
	onQuickFix: () => void;
	onOpenSettings: () => void;
};

export function StepInput({
	input,
	error,
	existing,
	githubConnected,
	onInputChange,
	onCreateIssue,
	onQuickFix,
	onOpenSettings,
}: StepInputProps) {
	const trimmed = input.trim();
	const canSubmit = trimmed.length > 0 && githubConnected;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<label
					htmlFor="feedback-input"
					className="text-[12px] font-medium tracking-[-0.01em]"
				>
					What would you like to tell us?
				</label>
				<Textarea
					id="feedback-input"
					value={input}
					onChange={(event) => onInputChange(event.target.value)}
					placeholder="Describe a bug, suggest an improvement, or ask a question."
					rows={6}
					autoFocus
					className="text-[13px] leading-snug"
				/>
			</div>

			{!githubConnected ? (
				<p className="text-[12px] leading-snug text-muted-foreground">
					Connect your GitHub account in{" "}
					<button
						type="button"
						onClick={onOpenSettings}
						className="cursor-pointer text-foreground underline underline-offset-2 hover:text-primary"
					>
						Settings
					</button>{" "}
					to continue.
				</p>
			) : null}

			{error ? (
				<p role="alert" className="text-[12px] leading-snug text-destructive">
					{error}. If this keeps failing, you can create an issue directly.
				</p>
			) : null}

			<div className="flex flex-col gap-1.5 pt-1">
				<div className="flex items-center justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onCreateIssue}
						disabled={!canSubmit}
					>
						<Send data-icon="inline-start" />
						Create issue
					</Button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="sm"
								onClick={onQuickFix}
								disabled={!canSubmit}
							>
								<Hammer data-icon="inline-start" />
								Quick fix
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							sideOffset={6}
							className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
						>
							<span className="leading-none">
								Contribute to Helmor — super easy
							</span>
						</TooltipContent>
					</Tooltip>
				</div>
				{existing && githubConnected ? (
					<p className="text-right text-[11px] text-muted-foreground">
						Will reuse your local helmor workspace
						{existing.branch ? ` (branch ${existing.branch})` : ""}.
					</p>
				) : null}
			</div>
		</div>
	);
}
