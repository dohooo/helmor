import {
	Check,
	ChevronDown,
	DownloadCloud,
	ExternalLink,
	GitMerge,
	GitPullRequestArrow,
	UploadCloud,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type CommitButtonState,
	getCommitButtonLabel,
	type WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import {
	type ChangeRequestInfo,
	pushWorkspaceToRemote,
	syncWorkspaceWithTargetBranch,
	triggerWorkspaceFetch,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface DiffCommitFooterProps {
	workspaceId: string | null;
	commitButtonMode: WorkspaceCommitButtonMode;
	commitButtonState: CommitButtonState;
	changeRequest: ChangeRequestInfo | null;
	hasUncommittedChanges: boolean;
	changeRequestName: string;
	onCommitAction?: (mode: WorkspaceCommitButtonMode) => Promise<void>;
}

/**
 * Sticky bottom of the Diff sub-tab. A free-form commit message textarea
 * stacked above a wide split-button. The main button label tracks the
 * smart commit mode (`Commit and Push`, `Create PR`, …); the chevron on
 * the right opens an imperative menu (Commit · Push · Create PR · …) so
 * users can override the smart action without it sticking as a default.
 *
 * The commit message persists per-workspace via localStorage so a stray
 * tab switch doesn't lose what you typed. Pressing Enter (without
 * Shift) fires the main action when there's something to commit; Shift
 * + Enter inserts a newline.
 */
export function DiffCommitFooter({
	workspaceId,
	commitButtonMode,
	commitButtonState,
	changeRequest,
	hasUncommittedChanges,
	changeRequestName,
	onCommitAction,
}: DiffCommitFooterProps) {
	const [message, setMessage] = useMessageDraft(workspaceId);
	const [menuOpen, setMenuOpen] = useState(false);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const disabled = commitButtonState === "disabled";
	const mainLabel = getCommitButtonLabel(
		commitButtonMode,
		commitButtonState,
		changeRequestName,
	);

	const runMain = async () => {
		if (disabled || !onCommitAction) return;
		// Per the design grill: Enter / main click fires the smart commit
		// action; if there's nothing to commit the button still works for
		// non-commit modes (push, create PR…) but the input would have
		// been empty anyway, so no message gets discarded.
		await onCommitAction(commitButtonMode);
	};

	const runDirect = async (id: string, fn: () => Promise<unknown>) => {
		if (busyAction) return;
		setBusyAction(id);
		try {
			await fn();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusyAction(null);
		}
	};

	const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.metaKey) {
			if (!hasUncommittedChanges) return;
			event.preventDefault();
			void runMain();
		}
	};

	const explicitMode = (mode: WorkspaceCommitButtonMode) => {
		if (!onCommitAction) return;
		void onCommitAction(mode);
		setMenuOpen(false);
	};

	const hasPr = !!changeRequest;
	const prUrl = changeRequest?.url ?? null;

	return (
		<div className="flex shrink-0 flex-col gap-2 border-t border-border/40 px-2.5 py-2.5">
			<textarea
				ref={textareaRef}
				value={message}
				onChange={(e) => setMessage(e.target.value)}
				onKeyDown={handleKey}
				placeholder="Commit message"
				rows={2}
				className={cn(
					"w-full resize-none rounded-md border border-border/60 bg-foreground/[0.025] px-2.5 py-2 text-[12px] leading-snug text-foreground placeholder:text-muted-foreground/70",
					"focus:border-foreground/30 focus:outline-none focus:ring-0",
				)}
			/>

			<div className="flex h-8 w-full items-stretch overflow-hidden rounded-md border border-border/60">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							disabled={disabled || !onCommitAction}
							onClick={runMain}
							className={cn(
								"group/main flex flex-1 cursor-pointer items-center justify-center gap-1.5 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:text-muted-foreground/60",
							)}
						>
							<Check
								className="size-3.5 text-muted-foreground/70 group-hover/main:text-foreground/80 group-disabled/main:text-muted-foreground/40"
								strokeWidth={2}
							/>
							<span>{mainLabel}</span>
						</button>
					</TooltipTrigger>
					<TooltipContent
						side="top"
						sideOffset={4}
						className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
					>
						{hasUncommittedChanges ? `${mainLabel} · Enter` : mainLabel}
					</TooltipContent>
				</Tooltip>
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="More commit actions"
							className="flex w-9 cursor-pointer items-center justify-center border-l border-border/60 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
						>
							<ChevronDown className="size-3.5" strokeWidth={2} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" sideOffset={6} className="w-56">
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								explicitMode("commit-and-push");
							}}
							disabled={!hasUncommittedChanges}
						>
							<Check className="size-4" strokeWidth={2} />
							<span>Commit and push</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								if (!workspaceId) return;
								void runDirect("push", () =>
									pushWorkspaceToRemote(workspaceId),
								);
								setMenuOpen(false);
							}}
						>
							<UploadCloud className="size-4" strokeWidth={2} />
							<span>Push</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								explicitMode("create-pr");
							}}
							disabled={hasPr}
						>
							<GitPullRequestArrow className="size-4" strokeWidth={2} />
							<span>{`Create ${changeRequestName}`}</span>
						</DropdownMenuItem>
						{hasPr ? (
							<DropdownMenuItem
								onSelect={(event) => {
									event.preventDefault();
									if (prUrl) window.open(prUrl, "_blank");
									setMenuOpen(false);
								}}
							>
								<ExternalLink className="size-4" strokeWidth={2} />
								<span>{`Open ${changeRequestName} in browser`}</span>
							</DropdownMenuItem>
						) : null}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								if (!workspaceId) return;
								void runDirect("sync", () =>
									syncWorkspaceWithTargetBranch(workspaceId),
								);
								setMenuOpen(false);
							}}
						>
							<GitMerge className="size-4" strokeWidth={2} />
							<span>Sync from main</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								if (!workspaceId) return;
								triggerWorkspaceFetch(workspaceId);
								setMenuOpen(false);
							}}
						>
							<DownloadCloud className="size-4" strokeWidth={2} />
							<span>Fetch</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

const STORAGE_PREFIX = "helmor.diff.commitDraft:";

/**
 * Per-workspace commit-message draft. Persisted across mounts so a stray
 * tab switch doesn't lose what you typed; cleared via the standard
 * `setMessage("")` after a successful commit (App-level handler will
 * call into this once the lifecycle wraps up — out of scope for this
 * footer's contract).
 */
function useMessageDraft(workspaceId: string | null) {
	const storageKey = workspaceId ? `${STORAGE_PREFIX}${workspaceId}` : null;
	const [message, setMessage] = useState<string>(() => {
		if (typeof window === "undefined" || !storageKey) return "";
		try {
			return window.localStorage.getItem(storageKey) ?? "";
		} catch {
			return "";
		}
	});

	useEffect(() => {
		if (typeof window === "undefined" || !storageKey) return;
		try {
			if (message) window.localStorage.setItem(storageKey, message);
			else window.localStorage.removeItem(storageKey);
		} catch {
			// non-fatal
		}
	}, [message, storageKey]);

	// Reset visible draft when the user switches workspaces.
	useEffect(() => {
		if (typeof window === "undefined" || !storageKey) {
			setMessage("");
			return;
		}
		try {
			setMessage(window.localStorage.getItem(storageKey) ?? "");
		} catch {
			setMessage("");
		}
	}, [storageKey]);

	return [message, setMessage] as const;
}
