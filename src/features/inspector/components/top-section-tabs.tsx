import { FolderTree, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

export type TopSectionView = "changes" | "files";

interface Props {
	value: TopSectionView;
	onChange: (value: TopSectionView) => void;
}

/**
 * Two-up segmented strip across the inspector top section. Each tab fills
 * half the available width — there are only ever two — and carries an icon
 * + label. Counts and indicators live on the inner sub-tabs (`Diff` /
 * `Checks`) instead of cluttering the top strip.
 */
export function TopSectionTabs({ value, onChange }: Props) {
	return (
		<div className="flex h-7 w-full items-center gap-1 rounded-md bg-muted/40 p-0.5">
			<TabButton
				active={value === "changes"}
				onClick={() => onChange("changes")}
				icon={<GitBranch className="size-3.5" strokeWidth={1.8} />}
				label="Changes"
			/>
			<TabButton
				active={value === "files"}
				onClick={() => onChange("files")}
				icon={<FolderTree className="size-3.5" strokeWidth={1.8} />}
				label="Files"
			/>
		</div>
	);
}

function TabButton({
	active,
	onClick,
	icon,
	label,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex h-6 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-[11.5px] font-medium leading-none",
				active
					? "bg-background text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{icon}
			<span className="leading-none">{label}</span>
		</button>
	);
}
