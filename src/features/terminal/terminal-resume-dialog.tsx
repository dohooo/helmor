import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { I18nText, useI18n } from "@/lib/i18n";

type TerminalResumeDialogProps = {
	open: boolean;
	/** Display name of the agent the terminal resumes ("Claude" / "Codex"). */
	providerLabel: string;
	dontRemind: boolean;
	onDontRemindChange: (checked: boolean) => void;
	/** Called with `false` on Cancel / dismiss. */
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
};

/** Heads-up shown before sending a conversation with history to the terminal:
 *  we open a NEW Terminal session that resumes the chat, and anything typed in
 *  the TUI won't sync back to this GUI conversation. */
export function TerminalResumeDialog({
	open,
	providerLabel,
	dontRemind,
	onDontRemindChange,
	onOpenChange,
	onConfirm,
}: TerminalResumeDialogProps) {
	const { f } = useI18n();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-[360px] gap-0 p-4"
				showCloseButton={false}
			>
				<DialogTitle className="text-ui font-semibold">
					<I18nText source="openTerminal" />
				</DialogTitle>
				<DialogDescription asChild>
					<ul className="mt-2 list-disc space-y-1 pl-4 text-small leading-relaxed text-muted-foreground">
						<li>
							<I18nText source="miscOpensNewTerminalSession" />
						</li>
						<li>{f("miscResumesConversationInProvider", { providerLabel })}</li>
						<li>
							<I18nText source="miscNewTerminalMessagesWontSyncBack" />
						</li>
					</ul>
				</DialogDescription>
				<div className="mt-3 flex w-fit items-center gap-2">
					<Checkbox
						id="terminal-resume-dont-remind"
						checked={dontRemind}
						onCheckedChange={(checked) => onDontRemindChange(checked === true)}
					/>
					<label
						htmlFor="terminal-resume-dont-remind"
						className="cursor-pointer text-small text-muted-foreground"
					>
						<I18nText source="miscDontRemindMeAgain" />
					</label>
				</div>
				<div className="mt-3 flex justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
					>
						<I18nText source="cancel" />
					</Button>
					<Button size="sm" onClick={onConfirm}>
						<I18nText source="openTerminal2" />
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
