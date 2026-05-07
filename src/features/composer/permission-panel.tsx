import type { PendingPermission } from "@/features/conversation/hooks/use-streaming";
import {
	ToolApprovalCard,
	type ToolApprovalCardProps,
} from "./user-input-panel/generic-renderer";

export type PermissionPanelProps = {
	permission: PendingPermission;
	disabled?: boolean;
	onResponse: (
		permissionId: string,
		behavior: "allow" | "deny",
		options?: { message?: string },
	) => void;
};

/**
 * Composer takeover for tool-permission requests. Renders the same
 * `ToolApprovalCard` (tool name + input preview + Allow/Deny) that
 * other approval-shaped flows use, and routes the click back to the
 * permission API. Distinct from `UserInputPanel` because permissions
 * have their own wire event (`permissionRequest`) and resolver IPC
 * (`respondToPermissionRequest`).
 */
export function PermissionPanel({
	permission,
	disabled,
	onResponse,
}: PermissionPanelProps) {
	const handleResponse: ToolApprovalCardProps["onResponse"] = (behavior) => {
		onResponse(permission.permissionId, behavior);
	};

	return (
		<ToolApprovalCard
			toolName={permission.toolName}
			toolInput={permission.toolInput}
			disabled={disabled}
			onResponse={handleResponse}
		/>
	);
}
