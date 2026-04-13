import { Check, MessageSquareMore, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionRowButton } from "@/components/action-row";
import { Textarea } from "@/components/ui/textarea";
import {
	autosizeTextarea,
	DeferredToolCard,
	type DeferredToolPanelProps,
	INLINE_TEXTAREA_CLASS,
} from "./shared";

export function GenericDeferredToolPanel({
	deferred,
	disabled,
	onResponse,
}: DeferredToolPanelProps) {
	const [reason, setReason] = useState("");
	const reasonRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		setReason("");
	}, [deferred.toolUseId]);

	useEffect(() => {
		autosizeTextarea(reasonRef.current);
	}, [reason]);

	return (
		<DeferredToolCard>
			{/* Header */}
			<div className="flex items-start gap-3 px-1 pb-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
					<Settings2 className="size-3.5" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-[13px] font-medium leading-5 text-foreground">
						{deferred.toolName}
					</p>
					<p className="mt-1 text-[11px] text-muted-foreground">
						This tool needs your approval before it can run.
					</p>
				</div>
			</div>

			{/* Tool input */}
			<div className="mx-1 rounded-xl bg-muted/20 px-3 py-2.5">
				<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">
					{JSON.stringify(deferred.toolInput, null, 2)}
				</pre>
			</div>

			{/* Reason area */}
			<div className="px-1 pt-2">
				<div className="flex items-start gap-2 px-2 py-1.5">
					<MessageSquareMore
						className="mt-1 size-3.5 shrink-0 text-muted-foreground/70"
						strokeWidth={1.8}
					/>
					<Textarea
						ref={reasonRef}
						rows={1}
						aria-label="Optional reason"
						disabled={disabled}
						placeholder="Optional reason"
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						className={INLINE_TEXTAREA_CLASS}
					/>
				</div>
			</div>

			{/* Footer */}
			<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/30 px-1 pt-2">
				<ActionRowButton
					disabled={disabled}
					onClick={() =>
						onResponse(deferred, "deny", {
							...(reason.trim() ? { reason: reason.trim() } : {}),
						})
					}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>Deny</span>
				</ActionRowButton>
				<ActionRowButton
					active
					disabled={disabled}
					onClick={() =>
						onResponse(deferred, "allow", {
							updatedInput: deferred.toolInput,
							...(reason.trim() ? { reason: reason.trim() } : {}),
						})
					}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>Allow</span>
				</ActionRowButton>
			</div>
		</DeferredToolCard>
	);
}
