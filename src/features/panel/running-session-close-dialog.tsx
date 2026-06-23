import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useI18n } from "@/lib/i18n";

type RunningSessionCloseDialogProps = {
	open: boolean;
	agentLabel: string;
	loading?: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
};

export function RunningSessionCloseDialog({
	open,
	agentLabel,
	loading = false,
	onOpenChange,
	onConfirm,
}: RunningSessionCloseDialogProps) {
	const { f } = useI18n();
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title="closeRunningChat"
			description={f("chatCurrentlyRunningClosingWillCancel", { agentLabel })}
			confirmLabel="closeAnyway"
			onConfirm={onConfirm}
			loading={loading}
		/>
	);
}
