import { Send } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ExistingHelmorWorkspace } from "@/lib/api";

import { buildPromptTemplate, type EnvironmentInfo } from "./helpers";

type StepPromptProps = {
	input: string;
	draftPrompt: string;
	existing: ExistingHelmorWorkspace | null;
	env: EnvironmentInfo;
	onEditPrompt: (prompt: string) => void;
	onSubmit: () => void;
};

export function StepPrompt({
	input,
	draftPrompt,
	existing,
	env,
	onEditPrompt,
	onSubmit,
}: StepPromptProps) {
	const template = useMemo(() => buildPromptTemplate(input, env), [input, env]);

	// Seed the prompt textarea with the default template the first time the
	// step renders. Subsequent edits are preserved verbatim.
	useEffect(() => {
		if (!draftPrompt) {
			onEditPrompt(template);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const trimmed = draftPrompt.trim();
	const canSubmit = trimmed.length > 0;

	return (
		<div className="flex flex-col gap-3">
			<h2 className="text-[13px] font-medium tracking-[-0.01em]">
				Step 2 · Refine your prompt
			</h2>
			<p className="text-[12px] leading-snug text-muted-foreground">
				This is the message the agent will receive. Tweak it if you want — the
				agent will ask clarifying questions before writing any code.
			</p>

			{existing ? (
				<p className="text-[11px] text-muted-foreground">
					Reusing your existing helmor workspace
					{existing.branch ? ` (branch ${existing.branch})` : ""}. A new branch
					will be created for this change.
				</p>
			) : null}

			<Textarea
				value={draftPrompt}
				onChange={(event) => onEditPrompt(event.target.value)}
				rows={10}
				className="text-[12px] leading-relaxed"
			/>

			<div className="flex items-center justify-end">
				<Button
					type="button"
					size="sm"
					onClick={onSubmit}
					disabled={!canSubmit}
				>
					<Send data-icon="inline-start" />
					Send to agent
				</Button>
			</div>
		</div>
	);
}
