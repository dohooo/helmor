import { ChevronDown, LogIn } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { AgentLoginDialog } from "@/components/agent-login/agent-login-dialog";
import type { ClaudeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { AgentLoginProvider } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProviderRow({
	icon: Icon,
	name,
	version,
	ready,
	loginProvider,
	onLoginExit,
	collapsible = false,
	defaultOpen = false,
	children,
}: {
	icon: typeof ClaudeIcon;
	name: string;
	version?: string | null;
	ready: boolean;
	loginProvider: AgentLoginProvider | null;
	onLoginExit?: () => void;
	collapsible?: boolean;
	defaultOpen?: boolean;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const [loginOpen, setLoginOpen] = useState(false);
	const hasChildren = Boolean(children);
	const expanded = collapsible ? open : true;

	// Re-check login status when the login dialog closes.
	const handleLoginOpenChange = useCallback(
		(next: boolean) => {
			setLoginOpen(next);
			if (!next) onLoginExit?.();
		},
		[onLoginExit],
	);

	const status = (
		<>
			{ready ? <StatusBadge /> : null}
			{loginProvider && !ready ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={(event) => {
						event.stopPropagation();
						setLoginOpen(true);
					}}
				>
					<LogIn className="size-3.5" />
					Log in
				</Button>
			) : null}
		</>
	);

	const identity = (
		<>
			<Icon className="size-5 shrink-0 text-foreground" />
			<div className="flex min-w-0 flex-1 items-baseline gap-2">
				<span className="text-ui font-medium leading-snug text-foreground">
					{name}
				</span>
				{version ? (
					<span className="shrink-0 font-mono text-mini leading-none text-muted-foreground/70">
						v{version}
					</span>
				) : null}
			</div>
		</>
	);

	// Chevron for collapsibles, equal-width spacer otherwise so the status control aligns across rows.
	const trailing = collapsible ? (
		<ChevronDown
			className={cn(
				"size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-foreground",
				!open && "-rotate-90",
			)}
			strokeWidth={1.8}
		/>
	) : (
		<span aria-hidden="true" className="size-4 shrink-0" />
	);

	return (
		<div>
			{collapsible ? (
				// A div, not <button>: the Login control nests inside, so button-in-button is invalid.
				<div
					role="button"
					tabIndex={0}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							setOpen((value) => !value);
						}
					}}
					// Fixed min-height so the async status control (badge ↔ login button) can't reflow the row.
					className="group flex min-h-[3.75rem] cursor-pointer items-center gap-3 py-4"
				>
					{identity}
					{status}
					{trailing}
				</div>
			) : (
				<div className="flex min-h-[3.75rem] items-center gap-3 py-4">
					{identity}
					{status}
					{trailing}
				</div>
			)}

			{/* Children stay mounted when collapsed so their one-time effects still run. */}
			{hasChildren ? (
				<div className={cn(!expanded && "hidden")}>{children}</div>
			) : null}

			{loginProvider ? (
				<AgentLoginDialog
					open={loginOpen}
					onOpenChange={handleLoginOpenChange}
					provider={loginProvider}
				/>
			) : null}
		</div>
	);
}

export function ProviderConfigRow({
	label,
	description,
	children,
}: {
	label?: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex gap-6 pb-4 pl-8">
			<div className="min-w-0 flex-1 pt-0.5">
				{label ? (
					<div className="text-ui font-medium leading-snug text-foreground">
						{label}
					</div>
				) : null}
				{description ? (
					<div
						className={cn(
							"text-small leading-snug text-muted-foreground",
							label && "mt-1",
						)}
					>
						{description}
					</div>
				) : null}
			</div>
			<div className="w-[360px] shrink-0">{children}</div>
		</div>
	);
}

function StatusBadge() {
	return (
		<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-mini font-medium text-emerald-500">
			<span className="size-1.5 rounded-full bg-emerald-500" />
			Ready
		</span>
	);
}
