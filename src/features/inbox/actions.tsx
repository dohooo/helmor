import { Search, X } from "lucide-react";
import { type ChangeEvent, type ComponentProps, forwardRef } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function InboxSearchField({
	value,
	onChange,
	onClear,
	ariaLabel,
	placeholder = "inboxSearch",
}: {
	value: string;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	onClear: () => void;
	ariaLabel: string;
	placeholder?: string;
}) {
	const { t } = useI18n();
	return (
		<div className="flex min-w-0 flex-1 items-center rounded-md border border-border/45 bg-background/35 px-1.5 text-muted-foreground transition-colors focus-within:border-border/80 focus-within:bg-background/55">
			<Search className="size-3 shrink-0" strokeWidth={1.9} />
			<input
				type="text"
				value={value}
				onChange={onChange}
				placeholder={t(placeholder)}
				aria-label={t(ariaLabel)}
				className="h-6 min-w-0 flex-1 bg-transparent px-1.5 text-mini text-foreground outline-none placeholder:text-muted-foreground/70"
			/>
			{value ? (
				<button
					type="button"
					aria-label={t("clearSearch")}
					onClick={onClear}
					className="flex size-4 cursor-interactive items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<X className="size-3" strokeWidth={2} />
				</button>
			) : null}
		</div>
	);
}

export const InboxActionIconButton = forwardRef<
	HTMLButtonElement,
	ComponentProps<"button">
>(function InboxActionIconButton(
	{ className, type = "button", "aria-label": ariaLabel, title, ...props },
	ref,
) {
	const { t } = useI18n();
	return (
		<button
			ref={ref}
			type={type}
			aria-label={typeof ariaLabel === "string" ? t(ariaLabel) : ariaLabel}
			title={typeof title === "string" ? t(title) : title}
			className={cn(
				"inline-flex size-7 shrink-0 cursor-interactive items-center justify-center rounded-md border border-border/45 bg-background/35 text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
});

export const InboxActionMenuButton = forwardRef<
	HTMLButtonElement,
	ComponentProps<"button">
>(function InboxActionMenuButton(
	{ className, type = "button", "aria-label": ariaLabel, title, ...props },
	ref,
) {
	const { t } = useI18n();
	return (
		<button
			ref={ref}
			type={type}
			aria-label={typeof ariaLabel === "string" ? t(ariaLabel) : ariaLabel}
			title={typeof title === "string" ? t(title) : title}
			className={cn(
				"inline-flex h-7 min-w-0 shrink-0 cursor-interactive items-center gap-1 rounded-md border border-border/45 bg-background/35 px-2 text-mini font-medium text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground",
				className,
			)}
			{...props}
		/>
	);
});
