import { ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pure-UI shell for the composer — the rounded surface with shadow ring,
 * the input slot at the top, and the toolbar / submit slot at the bottom.
 *
 * Mirrors the outer chrome of the real `WorkspaceComposer` (the rounded-2xl
 * sidebar-tinted box with shadow). The real composer fills the input slot
 * with a Lexical editor + slash-typeahead infrastructure; the onboarding
 * mockup just drops in a static placeholder paragraph.
 */
export function ComposerShellUI({
	input,
	toolbar,
	submit,
	className,
}: {
	input: ReactNode;
	toolbar?: ReactNode;
	submit?: ReactNode;
	className?: string;
}) {
	return (
		<div
			aria-label="Workspace composer"
			className={cn(
				"relative flex flex-col rounded-2xl border border-border/40 bg-sidebar shadow-[0_-1px_8px_rgba(0,0,0,0.05),0_0_0_1px_rgba(255,255,255,0.02)] px-4 pb-3 pt-3",
				className,
			)}
		>
			{input}
			{toolbar || submit ? (
				<div className="mt-2.5 flex items-end justify-between gap-3">
					<div className="flex flex-wrap items-center gap-2">{toolbar}</div>
					{submit}
				</div>
			) : null}
		</div>
	);
}

/**
 * The static "Ask to make changes…" placeholder used as a fallback for the
 * editor surface when no real Lexical instance is mounted.
 */
export function ComposerInputPlaceholderUI({
	placeholder = "Ask to make changes, @mention files, run /commands",
}: {
	placeholder?: string;
}) {
	return (
		<div className="min-h-[64px] max-h-[240px] whitespace-pre-wrap break-words bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-muted-foreground outline-none">
			{placeholder}
		</div>
	);
}

/** Submit button — the up-arrow on the bottom right of the composer. */
export function ComposerSubmitButtonUI() {
	return (
		<Button variant="outline" size="icon" className="rounded-[9px]">
			<ArrowUp className="size-[15px]" />
		</Button>
	);
}
