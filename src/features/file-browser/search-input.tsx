import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface Props {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}

export function SearchInput({
	value,
	onChange,
	placeholder = "Search files…",
	className,
}: Props) {
	return (
		<div
			className={cn(
				"flex h-8 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2",
				"focus-within:border-border focus-within:bg-background",
				className,
			)}
		>
			<Search
				className="size-3.5 shrink-0 text-muted-foreground"
				strokeWidth={1.8}
			/>
			<input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="flex-1 border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
			/>
			{value ? (
				<button
					type="button"
					onClick={() => onChange("")}
					className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
				>
					<X className="size-3" strokeWidth={2} />
				</button>
			) : null}
		</div>
	);
}
