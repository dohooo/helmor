import { CheckCircle2, ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { isMac } from "@/lib/platform";
import type { AgentProxySettings } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { SettingsRow } from "../components/settings-row";

const AGENT_PROXY_MODES: Array<{
	value: AgentProxySettings["mode"];
	label: string;
}> = [
	{ value: "none", label: "Not set" },
	{ value: "system", label: "System proxy" },
	{ value: "custom", label: "Custom proxy" },
];

export function AgentProxyPanel() {
	const { settings, updateSettings } = useSettings();
	const value = settings.agentProxy;
	const selected =
		AGENT_PROXY_MODES.find((option) => option.value === value.mode) ??
		AGENT_PROXY_MODES[0];
	if (!isMac()) return null;

	function updateProxy(patch: Partial<AgentProxySettings>) {
		void updateSettings({
			agentProxy: {
				...value,
				...patch,
			},
		});
	}

	return (
		<SettingsRow
			title="Proxy"
			description="Routes all provider traffic — Claude Code, Codex, OpenCode, MiMo Code, and Cursor."
			align="start"
			className="gap-8"
		>
			<div className="flex w-[360px] flex-col gap-2">
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"flex h-8 cursor-pointer items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
						)}
					>
						<span>{selected.label}</span>
						<ChevronDown className="size-3 opacity-40" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" sideOffset={4} className="w-40">
						{AGENT_PROXY_MODES.map((option) => (
							<DropdownMenuItem
								key={option.value}
								onClick={() => updateProxy({ mode: option.value })}
								className="justify-between gap-2"
							>
								<span>{option.label}</span>
								<CheckCircle2
									className={cn(
										"size-3.5 shrink-0 text-emerald-500",
										option.value !== value.mode && "invisible",
									)}
								/>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<Input
					value={value.customUrl}
					onChange={(event) => updateProxy({ customUrl: event.target.value })}
					placeholder="http://127.0.0.1:7890"
					disabled={value.mode !== "custom"}
					className="h-8 border-border/50 bg-muted/20 text-[13px]"
				/>
			</div>
		</SettingsRow>
	);
}
