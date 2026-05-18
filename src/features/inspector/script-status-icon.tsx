import {
	CircleCheck,
	CircleDashed,
	CircleQuestionMark,
	CircleX,
} from "lucide-react";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { cn } from "@/lib/utils";
import type { ScriptIconState } from "./hooks/use-script-status";

type ScriptStatusIconProps = {
	state: ScriptIconState;
	className?: string;
};

/**
 * Small status glyph rendered to the left of the Setup / Run tab labels.
 * Decorative — marked `aria-hidden` so it doesn't leak into the parent
 * TabsTrigger's accessible name (which would turn "Setup" into
 * "No script configured Setup" for screen readers and tests).
 *
 * Success / failure reuse the Git-actions PR accent tokens (open-accent
 * green, closed-accent red) so status semantics stay consistent across
 * the inspector. `no-script` and `idle` stay muted — they're neutral
 * states, not alerts. `running` uses the Helmor H logo animation.
 */
export function ScriptStatusIcon({ state, className }: ScriptStatusIconProps) {
	switch (state) {
		case "running":
			return (
				<HelmorLogoAnimated
					size={11}
					className={cn("shrink-0 opacity-85", className)}
				/>
			);
		case "success":
			return (
				<CircleCheck
					aria-hidden="true"
					className={cn(
						"size-3 shrink-0 text-[var(--workspace-pr-open-accent)]",
						className,
					)}
					strokeWidth={2}
				/>
			);
		case "failure":
			return (
				<CircleX
					aria-hidden="true"
					className={cn(
						"size-3 shrink-0 text-[var(--workspace-pr-closed-accent)]",
						className,
					)}
					strokeWidth={2}
				/>
			);
		case "no-script":
			return (
				<CircleQuestionMark
					aria-hidden="true"
					className={cn("size-3 shrink-0 text-muted-foreground/60", className)}
					strokeWidth={2}
				/>
			);
		case "idle":
			return (
				<CircleDashed
					aria-hidden="true"
					className={cn("size-3 shrink-0 text-muted-foreground/40", className)}
					strokeWidth={1.8}
				/>
			);
	}
}
