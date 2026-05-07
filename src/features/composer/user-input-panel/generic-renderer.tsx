import { Check, Settings2, X } from "lucide-react";
import { useMemo } from "react";
import { CodeBlock } from "@/components/ai/code-block";
import { Button } from "@/components/ui/button";
import { InteractionFooter, InteractionHeader } from "../interaction";
import { UserInputCard } from "./shared";

/**
 * Generic tool-approval card: renders a tool name + input preview +
 * Allow / Deny buttons. Currently consumed by `PermissionPanel` (see
 * `features/composer/permission-panel.tsx`) — permission requests
 * surface here verbatim. Kept independent of `PendingUserInput` so it
 * can be reused for any tool-approval-shaped flow without adapter
 * objects.
 */
export type ToolApprovalCardProps = {
	toolName: string;
	toolInput: Record<string, unknown>;
	disabled?: boolean;
	onResponse: (behavior: "allow" | "deny") => void;
};

function looksLikeCommand(
	toolName: string,
	toolInput: Record<string, unknown>,
) {
	const lowerName = toolName.toLowerCase();
	return (
		typeof toolInput.command === "string" &&
		toolInput.command.length > 0 &&
		(lowerName === "bash" || lowerName === "shell" || lowerName === "exec")
	);
}

function getCodePreview(
	toolName: string,
	toolInput: Record<string, unknown>,
): { code: string; language: string } {
	const command = toolInput?.command;
	if (
		typeof command === "string" &&
		command.length > 0 &&
		looksLikeCommand(toolName, toolInput)
	) {
		return { code: command, language: "bash" };
	}
	return {
		code: JSON.stringify(toolInput, null, 2),
		language: "json",
	};
}

export function ToolApprovalCard({
	toolName,
	toolInput,
	disabled,
	onResponse,
}: ToolApprovalCardProps) {
	const preview = useMemo(
		() => getCodePreview(toolName, toolInput),
		[toolName, toolInput],
	);

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Settings2}
				title={toolName}
				description="This tool needs your approval before it can run."
				truncateTitle
			/>
			<div className="mx-1 max-h-56 overflow-y-auto rounded-xl bg-muted/20">
				<CodeBlock
					code={preview.code}
					language={preview.language}
					variant="plain"
					wrapLines
				/>
			</div>

			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse("deny")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>Deny</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse("allow")}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>Allow</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
