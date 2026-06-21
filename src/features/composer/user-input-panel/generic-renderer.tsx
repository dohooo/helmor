import { Check, Settings2, X } from "lucide-react";
import { useMemo } from "react";
import { CodeBlock } from "@/components/ai/code-block";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
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
	/** Fallback resource label when `toolInput` is empty (e.g. OpenCode's
	 *  `patterns` — the file path / command being approved). */
	description?: string | null;
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
	description?: string | null,
): { code: string; language: string } {
	const command = toolInput?.command;
	if (
		typeof command === "string" &&
		command.length > 0 &&
		looksLikeCommand(toolName, toolInput)
	) {
		return { code: command, language: "bash" };
	}
	// Some agents (OpenCode read/skill/todo/shell) send an empty input object
	// and carry the target resource in `description` (its `patterns`). Show
	// that instead of a useless `{}`.
	if (toolInput == null || Object.keys(toolInput).length === 0) {
		const fallback = description?.trim();
		if (fallback) return { code: fallback, language: "text" };
	}
	return {
		code: JSON.stringify(toolInput, null, 2),
		language: "json",
	};
}

export function ToolApprovalCard({
	toolName,
	toolInput,
	description,
	disabled,
	onResponse,
}: ToolApprovalCardProps) {
	const { t } = useI18n();
	const preview = useMemo(
		() => getCodePreview(toolName, toolInput, description),
		[toolName, toolInput, description],
	);

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Settings2}
				title={toolName}
				description="toolNeedsApprovalBeforeCanRun"
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
					<span>{t("deny")}</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse("allow")}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>{t("allow")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
