import { Send } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ExistingHelmorRepo } from "@/lib/api";

import { buildPromptTemplate } from "./helpers";

type StepPromptProps = {
	input: string;
	draftPrompt: string;
	existing: ExistingHelmorRepo | null;
	onEditPrompt: (prompt: string) => void;
	onSubmit: () => void;
};

export function StepPrompt({
	input,
	draftPrompt,
	existing,
	onEditPrompt,
	onSubmit,
}: StepPromptProps) {
	const template = useMemo(() => buildPromptTemplate(input), [input]);

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
			<p className="text-[12px] leading-snug text-muted-foreground">
				Tweak this if you want — it's what the agent starts with.
				{existing ? " Reusing your local helmor repo." : null}
			</p>

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
