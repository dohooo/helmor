import { useMemo } from "react";
import type { PendingDeferredTool } from "@/features/conversation/pending-deferred-tool";
import type { DeferredToolResponseHandler } from "../deferred-tool";
import { normalizeDeferredTool } from "../deferred-tool";
import { AskUserQuestionPanel } from "./ask-user-question-panel";
import { GenericDeferredToolPanel } from "./generic-panel";

type DeferredToolPanelProps = {
	deferred: PendingDeferredTool;
	disabled?: boolean;
	onResponse: DeferredToolResponseHandler;
};

export function DeferredToolPanel({
	deferred,
	disabled = false,
	onResponse,
}: DeferredToolPanelProps) {
	const viewModel = useMemo(
		() => normalizeDeferredTool(deferred),
		[deferred.toolInput, deferred.toolName, deferred.toolUseId],
	);

	if (viewModel.kind === "ask-user-question") {
		return (
			<AskUserQuestionPanel
				deferred={deferred}
				disabled={disabled}
				onResponse={onResponse}
				viewModel={viewModel}
			/>
		);
	}

	return (
		<GenericDeferredToolPanel
			deferred={deferred}
			disabled={disabled}
			onResponse={onResponse}
		/>
	);
}
