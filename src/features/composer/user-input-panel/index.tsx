import { Info } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import { InteractionFooter, InteractionHeader } from "../interaction";
import type { UserInputResponseHandler } from "../user-input";
import { normalizeAskUserQuestion } from "../user-input";
import { AskUserQuestionRenderer } from "./ask-user-question-renderer";
import { ElicitationRenderer } from "./elicitation-renderers";
import { UserInputCard } from "./shared";

type UserInputPanelProps = {
	userInput: PendingUserInput;
	disabled?: boolean;
	onResponse: UserInputResponseHandler;
};

/**
 * Top-level dispatcher for the unified `userInputRequest` UI.
 *
 * Routes by `payload.kind` to a sub-renderer that preserves each
 * payload kind's native UX:
 *
 * - `ask-user-question` → `AskUserQuestionRenderer` (Claude AUQ:
 *   multi-question tabs, options + previews, optional notes,
 *   always-on "Other" free-text input).
 * - `form` → form variant of `ElicitationRenderer` (JSON-Schema
 *   driven form covering both Claude MCP form elicitations and
 *   Codex's synthesized form schemas).
 * - `url` → URL launcher variant of `ElicitationRenderer`.
 *
 * The shared visual shell + interaction primitives (Header / Footer /
 * Tabs / OptionRow) are common across all sub-renderers; only the
 * field/option logic differs per payload kind.
 */
export function UserInputPanel({
	userInput,
	disabled = false,
	onResponse,
}: UserInputPanelProps) {
	const askUserQuestionViewModel = useMemo(() => {
		if (userInput.payload.kind !== "ask-user-question") {
			return null;
		}
		return normalizeAskUserQuestion(userInput);
	}, [userInput]);

	if (askUserQuestionViewModel) {
		if (askUserQuestionViewModel.kind === "unsupported") {
			return (
				<UserInputCard>
					<InteractionHeader
						icon={Info}
						title="Unsupported request"
						description={askUserQuestionViewModel.reason}
					/>
					<InteractionFooter>
						<Button
							variant="outline"
							size="sm"
							disabled={disabled}
							onClick={() => onResponse(userInput, "cancel")}
						>
							Dismiss
						</Button>
					</InteractionFooter>
				</UserInputCard>
			);
		}
		return (
			<AskUserQuestionRenderer
				userInput={userInput}
				disabled={disabled}
				onResponse={onResponse}
				viewModel={askUserQuestionViewModel}
			/>
		);
	}

	return (
		<ElicitationRenderer
			userInput={userInput}
			disabled={disabled}
			onResponse={onResponse}
		/>
	);
}
