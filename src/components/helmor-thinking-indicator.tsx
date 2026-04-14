import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { cn } from "@/lib/utils";

type HelmorThinkingIndicatorProps = {
	size?: number | string;
	className?: string;
};

export function HelmorThinkingIndicator({
	size = 14,
	className,
}: HelmorThinkingIndicatorProps) {
	return (
		<span
			aria-hidden="true"
			data-slot="helmor-thinking-indicator"
			className={cn(
				"inline-flex shrink-0 items-center justify-center",
				className,
			)}
			style={{ width: size, height: size }}
		>
			<HelmorLogoAnimated size={size} className="shrink-0 opacity-80" />
		</span>
	);
}
