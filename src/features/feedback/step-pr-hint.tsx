import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

import { buildPrHint } from "./helpers";

type StepPrHintProps = {
	onOpenWorkspace: () => void;
};

export function StepPrHint({ onOpenWorkspace }: StepPrHintProps) {
	const hint = buildPrHint();
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(hint);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard may be blocked in some contexts; no-op.
		}
	}, [hint]);

	return (
		<div className="flex flex-col gap-3">
			<h2 className="text-[13px] font-medium tracking-[-0.01em]">
				Step 4 · The last 100 meters
			</h2>
			<p className="text-[12px] leading-snug text-muted-foreground">
				Your prompt is queued in the new workspace — press Send when you're
				ready to start the agent. Once the fix is done, paste this back to the
				agent to open a PR on <code>Dohoo/helmor</code>:
			</p>

			<div className="relative rounded-md border bg-muted/40 p-3">
				<pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
					{hint}
				</pre>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={() => {
						void handleCopy();
					}}
					className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
				>
					{copied ? (
						<Check className="size-3" strokeWidth={2.1} />
					) : (
						<Copy className="size-3" strokeWidth={1.8} />
					)}
					<span className="sr-only">{copied ? "Copied" : "Copy prompt"}</span>
				</Button>
			</div>

			<div className="flex items-center justify-end">
				<Button type="button" size="sm" onClick={onOpenWorkspace}>
					Open workspace
				</Button>
			</div>
		</div>
	);
}
