import {
	Archive,
	Hammer,
	Lightbulb,
	type LucideIcon,
	MessageSquareText,
	Orbit,
	Play,
} from "lucide-react";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { I18nText } from "@/lib/i18n";
import type { WorkspaceScriptType } from "@/lib/workspace-script-actions";
import { formatWorkspaceStarProgress } from "@/lib/workspace-star-collection";

const SCRIPT_ACTION_COPY: Record<
	WorkspaceScriptType,
	{ title: string; description: string; icon: LucideIcon }
> = {
	setup: {
		title: "Create setup script",
		description: "Bootstrap dependencies after a workspace is created.",
		icon: Hammer,
	},
	run: {
		title: "Create run actions",
		description:
			"Named commands you'll pick from the Inspector's Run dropdown.",
		icon: Play,
	},
	archive: {
		title: "Create archive script",
		description: "Light cleanup or handoff before archiving.",
		icon: Archive,
	},
};

export function EmptyState({
	hasSession,
	workspaceState = null,
	workspaceName = null,
	missingScriptTypes = [],
	onInitializeScript,
}: {
	hasSession: boolean;
	workspaceState?: string | null;
	workspaceName?: string | null;
	missingScriptTypes?: WorkspaceScriptType[];
	onInitializeScript?: (scriptType: WorkspaceScriptType) => void;
}) {
	const isCreatingWorkspace = workspaceState === "initializing";
	const showScriptActions =
		hasSession &&
		!isCreatingWorkspace &&
		missingScriptTypes.length > 0 &&
		typeof onInitializeScript === "function";
	const showEmptyStateMedia = isCreatingWorkspace || !hasSession;

	return (
		<Empty className="max-w-xl">
			<EmptyHeader>
				{showEmptyStateMedia ? (
					<EmptyMedia className="mb-1 text-muted-foreground [&_svg:not([class*='size-'])]:size-7">
						{isCreatingWorkspace ? (
							<HelmorLogoAnimated size={28} className="opacity-85" />
						) : (
							<MessageSquareText strokeWidth={1.7} />
						)}
					</EmptyMedia>
				) : null}
				<EmptyTitle
					className={
						hasSession && !isCreatingWorkspace
							? "text-foreground/70"
							: undefined
					}
				>
					{isCreatingWorkspace
						? "Creating workspace"
						: hasSession
							? "Nothing here yet"
							: "No session selected"}
				</EmptyTitle>
				<EmptyDescription>
					{isCreatingWorkspace ? (
						"Helmor is still preparing this workspace. Messaging will unlock automatically when setup finishes."
					) : hasSession ? (
						workspaceName ? (
							<span className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-muted-foreground/75">
								<span>New session in</span>
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											className="inline-flex cursor-interactive items-center align-middle font-medium leading-none text-muted-foreground/85 underline decoration-muted-foreground/45 decoration-1 underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
										>
											{workspaceName}
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="bottom"
										sideOffset={4}
										className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
									>
										<Orbit className="size-3 shrink-0" strokeWidth={1.8} />
										<span>{formatWorkspaceStarProgress(workspaceName)}</span>
									</TooltipContent>
								</Tooltip>
							</span>
						) : (
							"New session"
						)
					) : (
						"Choose a session from the header to inspect its timeline."
					)}
				</EmptyDescription>
			</EmptyHeader>
			{showScriptActions ? (
				<div
					aria-hidden="true"
					className="flex w-full max-w-[24rem] items-center gap-2"
				>
					<span className="h-px flex-1 bg-muted-foreground/12" />
					<span className="size-[3px] rounded-full bg-muted-foreground/12" />
					<span className="h-px flex-1 bg-muted-foreground/12" />
				</div>
			) : null}
			{showScriptActions ? (
				<EmptyContent className="mt-1 max-w-[22.25rem] items-stretch gap-2">
					{missingScriptTypes.map((scriptType) => {
						const item = SCRIPT_ACTION_COPY[scriptType];
						const Icon = item.icon;

						return (
							<button
								key={scriptType}
								type="button"
								onClick={() => onInitializeScript(scriptType)}
								className="group flex w-full cursor-interactive items-center gap-2.5 rounded-lg border border-border/70 bg-background px-2.5 py-2 text-left transition-[background-color,border-color] hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
							>
								<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/75 transition-colors group-hover:text-foreground">
									<Icon className="size-5" strokeWidth={1.75} />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="block text-small font-medium leading-[1.4] tracking-[-0.005em] text-foreground">
										{item.title}
									</span>
									<span className="mt-0.5 block text-mini leading-[1.5] text-muted-foreground">
										{item.description}
									</span>
								</span>
							</button>
						);
					})}
					<p className="mt-2 flex w-full items-center justify-center gap-1.5 whitespace-nowrap text-mini leading-[1.55] text-muted-foreground">
						<Lightbulb
							className="size-3 text-foreground/80"
							fill="currentColor"
							strokeWidth={1.5}
						/>
						<span>
							<span className="font-medium text-foreground/80">
								<I18nText source={"Tips:"} />
							</span>{" "}
							<I18nText
								source={"Configuring these scripts upgrades your dev loop."}
							/>
						</span>
					</p>
				</EmptyContent>
			) : null}
		</Empty>
	);
}
