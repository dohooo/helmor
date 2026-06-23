import type * as React from "react";

import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function Input({
	className,
	type,
	ref,
	placeholder,
	"aria-label": ariaLabel,
	title,
	...props
}: React.ComponentProps<"input">) {
	const { t } = useI18n();
	return (
		<input
			ref={ref}
			type={type}
			data-slot="input"
			placeholder={placeholder ? t(placeholder) : undefined}
			aria-label={typeof ariaLabel === "string" ? t(ariaLabel) : ariaLabel}
			title={typeof title === "string" ? t(title) : title}
			className={cn(
				"h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-body transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
