import { ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function KimiWireTypeSelect({
	value,
	onChange,
}: {
	value: "openai" | "anthropic";
	onChange: (v: "openai" | "anthropic") => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 text-ui text-foreground hover:bg-muted/40">
				<span className="flex min-w-0 items-center gap-2">
					<span className="text-muted-foreground">API style</span>
					<span className="truncate">
						{value === "anthropic" ? "Anthropic" : "OpenAI"}
					</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[300px]">
				<DropdownMenuItem onClick={() => onChange("openai")}>
					OpenAI (/v1/chat/completions)
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onChange("anthropic")}>
					Anthropic (/v1/messages)
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
