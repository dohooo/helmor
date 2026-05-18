import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";

type StepIssueDoneProps = {
	issueUrl: string;
	issueNumber: number;
	onClose: () => void;
};

export function StepIssueDone({
	issueUrl,
	issueNumber,
	onClose,
}: StepIssueDoneProps) {
	const handleOpen = () => {
		void openUrl(issueUrl);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-[13px]">
				<CheckCircle2 className="size-4 text-emerald-500" strokeWidth={2} />
				<span className="font-medium">Issue #{issueNumber} created</span>
			</div>
			<p className="text-[12px] leading-snug text-muted-foreground">
				Thanks for reporting! You can follow the discussion on GitHub.
			</p>
			<div className="flex items-center justify-end gap-2">
				<Button type="button" variant="outline" size="sm" onClick={onClose}>
					Close
				</Button>
				<Button type="button" size="sm" onClick={handleOpen}>
					<ExternalLink data-icon="inline-start" />
					Open on GitHub
				</Button>
			</div>
		</div>
	);
}
