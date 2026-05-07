import { MarkGithubIcon } from "@primer/octicons-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, LogIn, Plus, X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	AccountHoverCardContent,
	type ForgeAccountInfo,
} from "@/components/account-hover-card-content";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { CachedAvatar } from "@/components/cached-avatar";
import type { TerminalHandle } from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import {
	backfillForgeRepoBindings,
	type ForgeAccount,
	type ForgeProvider,
	listForgeLogins,
	resizeForgeCliAuthTerminal,
	type ScriptEvent,
	spawnForgeCliAuthTerminal,
	stopForgeCliAuthTerminal,
	writeForgeCliAuthTerminalStdin,
} from "@/lib/api";
import { initialsFor } from "@/lib/initials";
import { helmorQueryKeys } from "@/lib/query-client";
import { useForgeAccountsAll } from "@/lib/use-forge-accounts";
import { cn } from "@/lib/utils";
import { OnboardingTerminalPreview } from "../components/login-terminal-preview";
import type { OnboardingStep } from "../types";

const CLI_AUTH_POLL_INTERVAL_MS = 2000;
const CLI_AUTH_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_GITLAB_HOST = "gitlab.com";

type RepoCliProvider = Exclude<ForgeProvider, "unknown">;
type GitlabPanel = "host" | null;

type ActiveTerminal = {
	provider: RepoCliProvider;
	host: string;
	instanceId: string;
};

/// Tracks the "we just authed, profile is loading" state so the UI
/// can show a spinner where the new account will land instead of a
/// half-baked initials-only avatar.
type AddingAccount = {
	provider: RepoCliProvider;
	host: string;
	/** `null` until the post-CLI poll picks up which login appeared. */
	login: string | null;
};

/// Onboarding-local view of "is this provider/host authenticated?" —
/// just a list of logins. Multi-account aware: any non-empty list
/// counts as "ready", and the post-terminal poll uses it as the
/// baseline to detect a freshly-added login.
type CliState = {
	logins: string[];
	checking: boolean;
};

export function RepositoryCliStep({
	step,
	onBack,
	onNext,
}: {
	step: OnboardingStep;
	onBack: () => void;
	onNext: () => void;
}) {
	const [github, setGithub] = useState<CliState>({
		logins: [],
		checking: true,
	});
	const [gitlab, setGitlab] = useState<CliState>({
		logins: [],
		checking: true,
	});
	const [gitlabHost, setGitlabHost] = useState(DEFAULT_GITLAB_HOST);
	const [gitlabStatusHost, setGitlabStatusHost] = useState(DEFAULT_GITLAB_HOST);
	const [activeGitlabPanel, setActiveGitlabPanel] = useState<GitlabPanel>(null);
	const [activeTerminal, setActiveTerminal] = useState<ActiveTerminal | null>(
		null,
	);
	// Which provider tab is currently active in the add-account flow.
	// `null` = not adding (idle picker visible). Stays set across one
	// successful login so the user can immediately add another account
	// of the same kind without leaving the flow; only the × button
	// (handleAbortFlow) clears it.
	const [addFlowProvider, setAddFlowProvider] =
		useState<RepoCliProvider | null>(null);
	const [addingAccount, setAddingAccount] = useState<AddingAccount | null>(
		null,
	);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const queryClient = useQueryClient();
	// Include the active GitLab host so a brand-new host (no repos yet
	// in onboarding) gets probed by `listForgeAccounts` — otherwise the
	// freshly-added login never lands in `accountsQuery.data` and the
	// `useLayoutEffect` below can't clear the loading spinner.
	const extraGitlabHosts = useMemo(
		() => (gitlabStatusHost ? [gitlabStatusHost] : []),
		[gitlabStatusHost],
	);
	const accountsQuery = useForgeAccountsAll(extraGitlabHosts);

	const inFlow = addFlowProvider !== null;

	// Tracks whether the panel-collapse + TabButtons-fade-in sequence
	// has finished. Drives the "first time entering flow needs a 700ms
	// delay before terminal/host expand" vs "tab-to-tab switching is
	// instant" distinction. Without this the first delay leaks into
	// every subsequent provider switch and feels sluggish.
	const [flowSettled, setFlowSettled] = useState(false);
	useEffect(() => {
		if (!inFlow) {
			setFlowSettled(false);
			return;
		}
		if (flowSettled) return;
		const timer = setTimeout(() => setFlowSettled(true), 700);
		return () => clearTimeout(timer);
	}, [inFlow, flowSettled]);

	const clearPoll = useCallback(() => {
		if (pollTimerRef.current !== null) {
			clearTimeout(pollTimerRef.current);
			pollTimerRef.current = null;
		}
	}, []);

	// Keep already-fetched logins on screen while refetching: clearing
	// to `[]` causes the AccountListPanel avatar bar to flash empty
	// (and the compact "Checking…" text to flicker in) when the user
	// submits a GitLab host or otherwise re-triggers the load.
	useEffect(() => {
		let cancelled = false;
		setGithub((prev) => ({ logins: prev.logins, checking: true }));
		listForgeLogins("github", "github.com")
			.then((logins) => {
				if (!cancelled) setGithub({ logins, checking: false });
			})
			.catch(() => {
				if (!cancelled) {
					setGithub((prev) => ({ logins: prev.logins, checking: false }));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		setGitlab((prev) => ({ logins: prev.logins, checking: true }));
		listForgeLogins("gitlab", gitlabStatusHost)
			.then((logins) => {
				if (!cancelled) setGitlab({ logins, checking: false });
			})
			.catch(() => {
				if (!cancelled) {
					setGitlab((prev) => ({ logins: prev.logins, checking: false }));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [gitlabStatusHost]);

	useEffect(() => clearPoll, [clearPoll]);

	/// Reset the active add-flow tab to its initial sub-stage. For
	/// GitHub that's a fresh terminal spawn (re-running `gh auth
	/// login`); for GitLab it's the host-input form. Used after a
	/// successful login (so the user can immediately add another
	/// account of the same kind) and when switching tabs.
	const resetFlowTo = useCallback(
		(provider: RepoCliProvider) => {
			clearPoll();
			setAddFlowProvider(provider);
			if (provider === "github") {
				setActiveGitlabPanel(null);
				setActiveTerminal({
					provider: "github",
					host: "github.com",
					instanceId: crypto.randomUUID(),
				});
			} else {
				setActiveTerminal(null);
				setActiveGitlabPanel("host");
			}
		},
		[clearPoll],
	);

	/// Polls `listForgeLogins` until a login outside the baseline shows
	/// up (CLI auth lands), then awaits a refetch of the heavier
	/// account roster so the new avatar / display name are in the
	/// React Query cache before we drop the pending state. Net effect:
	/// stack avatar goes spinner → real photo without flashing
	/// initials in between, and the loading row + avatar swap commit
	/// in the same React render.
	const pollUntilReady = useCallback(
		(
			provider: RepoCliProvider,
			host: string,
			baseline: Set<string>,
			startedAt = Date.now(),
		) => {
			clearPoll();
			const tick = async () => {
				let logins: string[] | null = null;
				try {
					logins = await listForgeLogins(provider, host, {
						forceRefresh: true,
					});
				} catch {
					// Auth may still be in progress; we'll retry below.
				}
				const newLogin = logins?.find((login) => !baseline.has(login));
				if (logins && newLogin) {
					// Surface the login + kick off a refetch of the
					// account roster. We *don't* clear `addingAccount`
					// here — that's handled by the `useLayoutEffect`
					// below that watches `accountsQuery.data` and clears
					// pending the same React commit the avatar lands.
					setAddingAccount({ provider, host, login: newLogin });
					if (provider === "github") {
						setGithub({ logins, checking: false });
					} else {
						setGitlab({ logins, checking: false });
					}
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.forgeAccountsAll,
					});
					return;
				}
				if (Date.now() - startedAt >= CLI_AUTH_POLL_TIMEOUT_MS) {
					// Polling never observed a new login (e.g. user
					// cancelled in-browser, or re-authed an existing
					// account so the set never grew). Drop pending so
					// the spinner doesn't linger; keep the flow open so
					// the user can retry from the same tab.
					setAddingAccount(null);
					toast(
						`Finish ${provider === "gitlab" ? "GitLab" : "GitHub"} CLI auth, then click Set up again.`,
					);
					return;
				}
				pollTimerRef.current = setTimeout(tick, CLI_AUTH_POLL_INTERVAL_MS);
			};
			// Fire immediately — gh/glab usually has the new login on disk
			// by the time the terminal closes, so waiting 2s would just
			// add a visible delay before the spinner appears.
			void tick();
		},
		[clearPoll, queryClient],
	);

	// Clear pending the same React commit the new avatar lands. We
	// watch `accountsQuery.data` (the same source `AccountListPanel`
	// reads for the stack avatars) and trigger the cleanup as soon as
	// the login shows up there. Using `useLayoutEffect` so the
	// `setAddingAccount(null)` re-render runs synchronously before
	// paint — the user never sees a frame with "real avatar + still
	// loading".
	useLayoutEffect(() => {
		const pending = addingAccount;
		if (!pending?.login) return;
		const found = accountsQuery.data?.some(
			(a) => a.provider === pending.provider && a.login === pending.login,
		);
		if (!found) return;
		setAddingAccount(null);
		// Re-arm the same tab's next stage so the user can chain
		// another login. GitHub spawns a fresh terminal; GitLab
		// opens the host input form.
		resetFlowTo(pending.provider);
		// Sync the just-added account against any pre-existing repos
		// (e.g. from a prior session) so they pick up the binding
		// without an app restart. Mirrors the Settings → Account flow.
		void backfillForgeRepoBindings()
			.then((bound) => {
				if (bound > 0) {
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.repositories,
					});
				}
			})
			.catch(() => {});
		const label = pending.provider === "gitlab" ? "GitLab" : "GitHub";
		toast.success(`${label} connected as @${pending.login}`);
	}, [addingAccount, accountsQuery.data, resetFlowTo, queryClient]);

	// Fail-safe: if the profile fetch never lands (network error,
	// stale cache, etc.) drop pending after 10s so the spinner can't
	// hang forever. Keeps the flow open so the user can re-try.
	useEffect(() => {
		if (!addingAccount?.login) return;
		const timer = setTimeout(() => setAddingAccount(null), 10_000);
		return () => clearTimeout(timer);
	}, [addingAccount]);

	const openTerminal = useCallback(
		(provider: RepoCliProvider, host: string) => {
			clearPoll();
			setActiveGitlabPanel(null);
			setActiveTerminal({
				provider,
				host,
				instanceId: crypto.randomUUID(),
			});
		},
		[clearPoll],
	);

	const handleTerminalExit = useCallback(
		(code: number | null) => {
			if (!activeTerminal) return;
			const baseline = new Set(
				(activeTerminal.provider === "github" ? github : gitlab).logins,
			);
			if (code !== 0) {
				// User cancelled (×, Ctrl+C, terminal kill) or the CLI
				// failed — collapse everything back to the idle picker.
				setActiveTerminal(null);
				setActiveGitlabPanel(null);
				setAddFlowProvider(null);
				setAddingAccount(null);
				return;
			}
			// Successful auth: surface the loading state immediately
			// (login=null until the poll picks the real one). The
			// terminal stays mounted so the CLI's "Logged in as …"
			// output stays visible during the profile fetch.
			setAddingAccount({
				provider: activeTerminal.provider,
				host: activeTerminal.host,
				login: null,
			});
			pollUntilReady(activeTerminal.provider, activeTerminal.host, baseline);
		},
		[activeTerminal, github, gitlab, pollUntilReady],
	);

	const handleTerminalError = useCallback(() => {
		setActiveTerminal(null);
		setActiveGitlabPanel(null);
		setAddFlowProvider(null);
		setAddingAccount(null);
	}, []);

	/// Bail out of the active add-flow (terminal or GitLab host input)
	/// and return to the picker. Wired into the embedded terminal's
	/// title-bar close button + the host panel's close button.
	/// `setActiveTerminal(null)` triggers the `ForgeCliTerminalPreview`
	/// effect cleanup, which kills the spawned PTY.
	const handleAbortFlow = useCallback(() => {
		clearPoll();
		setActiveTerminal(null);
		setActiveGitlabPanel(null);
		setAddFlowProvider(null);
		setAddingAccount(null);
	}, [clearPoll]);

	const handleGithubSetUp = useCallback(() => {
		// Don't gate on "already has any account" — onboarding's Set up
		// button should always open the terminal so the user can add a
		// fresh account or re-auth if their current one is broken.
		resetFlowTo("github");
	}, [resetFlowTo]);

	const handleGitlabSetUp = useCallback(() => {
		resetFlowTo("gitlab");
	}, [resetFlowTo]);

	const handleGitlabHostSubmit = useCallback(() => {
		const host = normalizeGitlabHost(gitlabHost);
		if (!host) {
			toast.error("Enter a GitLab domain.");
			return;
		}
		setGitlabHost(host);
		// Setting `gitlabStatusHost` triggers the loader effect for
		// gitlab logins (see `useEffect([gitlabStatusHost])` above) —
		// no need for a manual `refreshStatus` here. That parallel
		// fetch lands well before the user finishes CLI auth, so the
		// post-terminal poll baseline ends up correct.
		setGitlabStatusHost(host);
		clearPoll();
		openTerminal("gitlab", host);
	}, [clearPoll, gitlabHost, openTerminal]);

	return (
		<section
			aria-label="Repository CLI setup"
			aria-hidden={step !== "corner"}
			className={`absolute top-20 right-20 z-30 w-[560px] transition-all duration-1000 ease-[cubic-bezier(.22,.82,.2,1)] ${
				step === "skills"
					? "pointer-events-none translate-x-[118vw] -translate-y-[55vh] opacity-100"
					: step === "corner"
						? "translate-x-0 translate-y-0 opacity-100"
						: "pointer-events-none translate-x-[64vw] -translate-y-[108vh] opacity-100"
			}`}
		>
			<div className="flex flex-col items-start">
				<h2 className="max-w-none text-4xl font-semibold leading-[1.02] tracking-normal text-foreground whitespace-nowrap">
					Connect accounts
				</h2>
				<p className="mt-4 max-w-md text-[12.5px] leading-5 text-muted-foreground">
					Each repo uses one of your accounts. Add now or skip — existing logins
					are picked up automatically. All accounts live in your local gh/glab
					CLI.
				</p>

				<div className="mt-7 grid w-full gap-3">
					<AccountListPanel
						githubLogins={github.logins}
						gitlabLogins={gitlab.logins}
						gitlabStatusHost={gitlabStatusHost}
						loading={github.checking || gitlab.checking}
						compact={inFlow}
						addingAccount={addingAccount}
						accounts={accountsQuery.data ?? []}
						onAddGithub={handleGithubSetUp}
						onAddGitlab={handleGitlabSetUp}
					/>

					{/* Sequential animation orchestration:
					 *    1. AccountListPanel collapses (700ms)
					 *    2. TabButtons slot grows + content fades in
					 *       (height tracks panel collapse; opacity has
					 *       a 350ms delay so the buttons appear "into"
					 *       a slot that's already partway opened)
					 *    3. Terminal/Host slots open with 700ms delay
					 *       so they wait until the tab buttons settle.
					 *  Closing reverses with no delays — everything
					 *  collapses in parallel for a snappy exit. */}
					<TabButtons
						inFlow={inFlow}
						activeProvider={addFlowProvider}
						onAddGithub={handleGithubSetUp}
						onAddGitlab={handleGitlabSetUp}
					/>

					{/* Terminal sits ABOVE the GitLab host slot so its top
					 *  edge stays pinned to the picker — host slot
					 *  collapsing underneath can't tug it upward. */}
					<RepositoryCliTerminalSlot
						active={activeTerminal !== null}
						flowSettled={flowSettled}
						terminal={activeTerminal}
						onTerminalExit={handleTerminalExit}
						onTerminalError={handleTerminalError}
						onClose={handleAbortFlow}
					/>

					<GitlabHostSlot
						active={activeGitlabPanel === "host"}
						flowSettled={flowSettled}
						value={gitlabHost}
						onChange={setGitlabHost}
						onSubmit={handleGitlabHostSubmit}
						onClose={handleAbortFlow}
					/>
				</div>

				<div className="mt-7 flex items-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="lg"
						onClick={onBack}
						className="h-9 gap-2 px-4 text-[0.95rem]"
					>
						<ArrowLeft data-icon="inline-start" className="size-4" />
						Back
					</Button>
					<Button
						type="button"
						size="lg"
						onClick={onNext}
						className="h-9 gap-2 px-4 text-[0.95rem]"
					>
						Next
						<ArrowRight data-icon="inline-end" className="size-4" />
					</Button>
				</div>
			</div>
		</section>
	);
}

/// Renders existing accounts and — when idle — the dashed-border
/// picker slot. The dashed shell is only an anchor + visual hint;
/// the actual clickable buttons live in `<FloatingPickerButtons>`
/// up at the section level so they can translate freely between
/// the picker slot and the tab anchor below the panel.
function AccountListPanel({
	githubLogins,
	gitlabLogins,
	gitlabStatusHost,
	loading,
	compact,
	addingAccount,
	accounts,
	onAddGithub,
	onAddGitlab,
}: {
	githubLogins: string[];
	gitlabLogins: string[];
	gitlabStatusHost: string;
	loading: boolean;
	/** Switch to a single-row stacked-avatar view while a flow is
	 *  open, so the panel can't push the terminal off-screen. */
	compact: boolean;
	addingAccount: AddingAccount | null;
	/** Hoisted from the parent so onboarding's extra-host probe is
	 * shared rather than diverging into its own cache entry. */
	accounts: ForgeAccount[];
	onAddGithub: () => void;
	onAddGitlab: () => void;
}) {
	const accountByLogin = new Map<string, ForgeAccount>();
	for (const account of accounts) {
		accountByLogin.set(`${account.provider}::${account.login}`, account);
	}

	const rows: Array<{
		provider: RepoCliProvider;
		host: string;
		login: string;
		account: ForgeAccount | null;
	}> = [];
	for (const login of githubLogins) {
		rows.push({
			provider: "github",
			host: "github.com",
			login,
			account: accountByLogin.get(`github::${login}`) ?? null,
		});
	}
	for (const login of gitlabLogins) {
		rows.push({
			provider: "gitlab",
			host: gitlabStatusHost,
			login,
			account: accountByLogin.get(`gitlab::${login}`) ?? null,
		});
	}

	// Drive panel height off the inner wrapper so list↔stack swaps
	// animate. `useLayoutEffect` re-measures synchronously after each
	// commit (compact toggling, account list changes), and the outer
	// shell transitions `height` to that pixel value over the same
	// 700ms / cubic-bezier the floating buttons use — so the panel
	// shrink and the buttons sliding up are the same motion.
	const innerRef = useRef<HTMLDivElement>(null);
	const [innerHeight, setInnerHeight] = useState<number | null>(null);
	const totalRows = githubLogins.length + gitlabLogins.length;
	useLayoutEffect(() => {
		if (innerRef.current) {
			setInnerHeight(innerRef.current.offsetHeight);
		}
	}, [compact, totalRows]);

	return (
		<div
			style={{
				// `+ 2` covers the 1px top + 1px bottom border so the
				// inner block fits flush; without it the bottom of the
				// content gets clipped by the overflow-hidden during the
				// transition.
				height: innerHeight !== null ? `${innerHeight + 2}px` : undefined,
			}}
			className="overflow-hidden rounded-xl border border-border/55 bg-card/40 transition-[height] duration-700 ease-[cubic-bezier(.22,.82,.2,1)]"
		>
			<div ref={innerRef} className="p-3">
				{compact ? (
					<CompactAccountStack rows={rows} addingAccount={addingAccount} />
				) : rows.length === 0 ? (
					<div className="flex items-center justify-center px-2 py-4 text-[12px] text-muted-foreground">
						{loading
							? "Checking for connected accounts…"
							: "No accounts connected yet."}
					</div>
				) : (
					<ul className="divide-y divide-border/40">
						{rows.map((row) => (
							<AccountRow
								key={`${row.provider}::${row.host}::${row.login}`}
								row={row}
							/>
						))}
					</ul>
				)}
				{/* Idle-only picker. Dashed `+` shell with a hover-reveal
				 *  pair of provider buttons inside. Removed entirely in
				 *  compact mode so the panel collapses to a single row. */}
				{compact ? null : (
					<PickerHoverReveal
						onAddGithub={onAddGithub}
						onAddGitlab={onAddGitlab}
					/>
				)}
			</div>
		</div>
	);
}

/// Idle-state picker living inside the AccountListPanel: a dashed
/// `+` shell that swaps to two solid provider buttons on hover or
/// keyboard focus. Owns its own hover state via CSS `:hover` /
/// `:focus-within` — no parent JS plumbing.
function PickerHoverReveal({
	onAddGithub,
	onAddGitlab,
}: {
	onAddGithub: () => void;
	onAddGitlab: () => void;
}) {
	return (
		<div className="group relative mt-3 h-9">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
			>
				<Plus className="size-4" strokeWidth={2.2} />
			</div>
			<div className="pointer-events-none absolute inset-0 grid grid-cols-2 gap-2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
				<PickerButton
					onClick={onAddGithub}
					muted={false}
					icon={<MarkGithubIcon size={14} />}
					label="GitHub"
				/>
				<PickerButton
					onClick={onAddGitlab}
					muted={false}
					icon={<GitlabBrandIcon size={14} className="text-[#FC6D26]" />}
					label="GitLab"
				/>
			</div>
		</div>
	);
}

/// Flow-state tab strip that lives below the panel. Independent of
/// the idle hover-reveal buttons — no shared element, no transform
/// tracking. Outer `h-0 ↔ h-9` height transition is what reserves /
/// releases the row in the layout (so the panel↔terminal spacing
/// stays clean). Inner content fades + slides in with a 350ms
/// `transition-delay` on open so it appears "into" a slot that's
/// already part-way grown — and closes instantly with no delay so
/// the exit feels snappy.
function TabButtons({
	inFlow,
	activeProvider,
	onAddGithub,
	onAddGitlab,
}: {
	inFlow: boolean;
	activeProvider: RepoCliProvider | null;
	onAddGithub: () => void;
	onAddGitlab: () => void;
}) {
	return (
		<div
			aria-hidden={!inFlow}
			className={cn(
				"overflow-hidden transition-[height] duration-700 ease-[cubic-bezier(.22,.82,.2,1)]",
				inFlow ? "h-9" : "h-0",
			)}
		>
			<div
				style={{
					// Open: 0ms duration with a 700ms delay snaps opacity
					// from 0 → 1 the same frame the panel finishes
					// collapsing and the terminal slot starts expanding —
					// no fade. Close: no transition — opacity blinks out
					// while the outer slot collapses.
					transition: inFlow ? "opacity 0ms 700ms" : "none",
				}}
				className={cn(
					"grid h-9 grid-cols-2 gap-2",
					inFlow ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			>
				<PickerButton
					onClick={onAddGithub}
					muted={inFlow && activeProvider !== "github"}
					icon={<MarkGithubIcon size={14} />}
					label="GitHub"
				/>
				<PickerButton
					onClick={onAddGitlab}
					muted={inFlow && activeProvider !== "gitlab"}
					icon={<GitlabBrandIcon size={14} className="text-[#FC6D26]" />}
					label="GitLab"
				/>
			</div>
		</div>
	);
}

function PickerButton({
	onClick,
	muted,
	icon,
	label,
}: {
	onClick: () => void;
	/** Dim styling for the non-active provider while a flow is open. */
	muted: boolean;
	icon: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex h-full cursor-pointer items-center justify-center gap-2 rounded-lg border text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring/60",
				muted
					? "border-border/40 bg-card/40 text-muted-foreground hover:border-border/70 hover:bg-card/70 hover:text-foreground"
					: "border-border/55 bg-card/80 text-foreground hover:bg-card focus-visible:bg-card",
			)}
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

const COMPACT_AVATAR_LIMIT = 6;

function CompactAccountStack({
	rows,
	addingAccount,
}: {
	rows: Array<{
		provider: RepoCliProvider;
		host: string;
		login: string;
		account: ForgeAccount | null;
	}>;
	addingAccount: AddingAccount | null;
}) {
	const addingLabel = addingAccount
		? addingAccount.login
			? `Adding @${addingAccount.login}…`
			: `Adding ${addingAccount.provider === "gitlab" ? "GitLab" : "GitHub"} account…`
		: null;

	if (rows.length === 0) {
		// Compact mode is only active while the terminal / host panel is
		// open, so the user is already mid-add. If we're already past
		// the CLI auth and waiting on profile data, show the loading
		// label here too.
		return (
			<div className="flex items-center gap-3">
				{addingLabel ? (
					<>
						<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
						<span className="text-[12px] text-muted-foreground">
							{addingLabel}
						</span>
					</>
				) : (
					<span className="text-[12px] text-muted-foreground">
						No accounts connected yet.
					</span>
				)}
			</div>
		);
	}
	const visible = rows.slice(0, COMPACT_AVATAR_LIMIT);
	const overflow = rows.length - visible.length;
	return (
		<div className="flex items-center gap-3">
			<div className="flex min-w-0 items-center gap-2.5">
				<div className="flex items-center -space-x-2">
					{visible.map((row) => (
						<StackedAccountAvatar
							key={`${row.provider}::${row.host}::${row.login}`}
							row={row}
							isPending={
								addingAccount?.provider === row.provider &&
								addingAccount?.login === row.login
							}
						/>
					))}
					{overflow > 0 ? (
						<div
							className="flex size-7 items-center justify-center rounded-full border-2 border-card bg-muted text-[10px] font-semibold text-muted-foreground"
							title={`${overflow} more account${overflow === 1 ? "" : "s"}`}
						>
							+{overflow}
						</div>
					) : null}
				</div>
				<span className="truncate text-[12px] text-muted-foreground">
					{addingLabel ?? `${rows.length} connected`}
				</span>
			</div>
		</div>
	);
}

function StackedAccountAvatar({
	row,
	isPending,
}: {
	row: {
		provider: RepoCliProvider;
		host: string;
		login: string;
		account: ForgeAccount | null;
	};
	/** Profile fetch is mid-flight for this row — show a spinner
	 *  instead of initials so the eventual avatar swap doesn't look
	 *  like a fallback flashing in. */
	isPending?: boolean;
}) {
	const displayName = row.account?.name?.trim() || row.login;
	const showSpinner = isPending && !row.account?.avatarUrl;
	const hoverInfo: ForgeAccountInfo = {
		provider: row.provider,
		host: row.host,
		login: row.login,
		avatarUrl: row.account?.avatarUrl,
		name: row.account?.name,
		email: row.account?.email,
	};
	return (
		<HoverCard openDelay={120} closeDelay={80}>
			<HoverCardTrigger asChild>
				<span className="inline-flex">
					<CachedAvatar
						size="sm"
						className="size-7 cursor-default ring-2 ring-card transition-transform hover:z-10 hover:scale-110"
						src={row.account?.avatarUrl}
						alt={row.login}
						fallback={
							showSpinner ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								initialsFor(displayName)
							)
						}
						fallbackClassName="bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
					/>
				</span>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="start"
				sideOffset={8}
				className="w-auto max-w-[260px] p-3"
			>
				<AccountHoverCardContent account={hoverInfo} />
			</HoverCardContent>
		</HoverCard>
	);
}

function AccountRow({
	row,
}: {
	row: {
		provider: RepoCliProvider;
		host: string;
		login: string;
		account: ForgeAccount | null;
	};
}) {
	const account = row.account;
	const displayName = account?.name?.trim() || row.login;
	const providerIcon =
		row.provider === "gitlab" ? (
			<GitlabBrandIcon size={11} className="text-[#FC6D26]" />
		) : (
			<GithubBrandIcon size={11} />
		);
	return (
		<li className="flex items-center gap-3 px-1 py-2">
			<CachedAvatar
				size="sm"
				className="size-8"
				src={account?.avatarUrl}
				alt={row.login}
				fallback={initialsFor(displayName)}
				fallbackClassName="bg-muted text-[12px] font-semibold uppercase text-muted-foreground"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-[12.5px] font-medium text-foreground">
						{displayName}
					</span>
					<span className="truncate text-[11px] text-muted-foreground">
						@{row.login}
					</span>
				</div>
				<div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground">
					{providerIcon}
					<span className="truncate">
						{row.provider === "gitlab" ? `GitLab · ${row.host}` : "GitHub"}
					</span>
				</div>
			</div>
		</li>
	);
}

function RepositoryCliTerminalSlot({
	active,
	flowSettled,
	terminal,
	onTerminalExit,
	onTerminalError,
	onClose,
}: {
	active: boolean;
	/** True once the panel-collapse + TabButtons-fade-in handshake
	 *  has finished. Drives whether the terminal slot waits for that
	 *  sequence (first time entering flow) or expands immediately
	 *  (tab-to-tab provider switch with the panel already compact). */
	flowSettled: boolean;
	terminal: ActiveTerminal | null;
	onTerminalExit: (code: number | null) => void;
	onTerminalError: (message: string) => void;
	onClose: () => void;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden transition-all duration-700 ease-[cubic-bezier(.22,.82,.2,1)]",
				active ? "h-[270px]" : "h-0",
			)}
			style={{
				// First time entering flow (`!flowSettled`): wait for
				// panel collapse + tab fade-in. Once `flowSettled` is
				// true, tab-to-tab switches are instant.
				// Closing: always 0ms.
				transitionDelay: active && !flowSettled ? "700ms" : "0ms",
			}}
		>
			<div className="relative h-[258px]">
				<ForgeCliTerminalPreview
					active={active}
					terminal={terminal}
					onExit={onTerminalExit}
					onError={onTerminalError}
					onClose={onClose}
				/>
			</div>
		</div>
	);
}

/// Slot for the GitLab host input. Both opening and closing run a
/// height transition so it stays in lockstep with the panel collapse
/// and the tab fade-in / out. Opening is gated behind a 700ms delay
/// so the slot waits until the tab buttons settle before sliding in;
/// closing has no delay so the exit feels snappy and the Back / Next
/// buttons glide up immediately.
function GitlabHostSlot({
	active,
	flowSettled,
	value,
	onChange,
	onSubmit,
	onClose,
}: {
	active: boolean;
	flowSettled: boolean;
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onClose: () => void;
}) {
	const openDelay = active && !flowSettled ? "700ms" : "0ms";
	return (
		<div
			className="overflow-hidden transition-[height] duration-700 ease-[cubic-bezier(.22,.82,.2,1)]"
			style={{
				height: active ? "168px" : "0px",
				transitionDelay: openDelay,
			}}
		>
			<div className="relative h-full">
				<div
					style={{
						transitionDelay: openDelay,
					}}
					className={cn(
						"absolute inset-x-0 top-0 rounded-xl border border-border/55 bg-card p-4 shadow-md transition-all duration-700 ease-[cubic-bezier(.22,.82,.2,1)]",
						active
							? "translate-x-0 opacity-100"
							: "pointer-events-none translate-x-[calc(100%+3rem)] opacity-0",
					)}
				>
					<button
						type="button"
						onClick={onClose}
						aria-label="Cancel"
						className="absolute top-3 right-3 inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="size-3.5" strokeWidth={2.4} />
					</button>
					<div className="text-sm font-medium text-foreground">
						GitLab domain
					</div>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						Use gitlab.com or your self-hosted GitLab domain.
					</p>
					<form
						className="mt-4 flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							onSubmit();
						}}
					>
						<Input
							value={value}
							onChange={(event) => onChange(event.target.value)}
							placeholder={DEFAULT_GITLAB_HOST}
							aria-label="GitLab domain"
							className="h-10"
						/>
						<Button type="submit" className="h-10 shrink-0 gap-2 px-3">
							<LogIn className="size-4" />
							Log in
						</Button>
					</form>
				</div>
			</div>
		</div>
	);
}

function ForgeCliTerminalPreview({
	active,
	terminal,
	onExit,
	onError,
	onClose,
}: {
	active: boolean;
	terminal: ActiveTerminal | null;
	onExit: (code: number | null) => void;
	onError: (message: string) => void;
	onClose: () => void;
}) {
	const termRef = useRef<TerminalHandle | null>(null);
	// Keep onExit/onError out of the spawn effect's deps — parent
	// re-renders recreate them, and a re-run kills the just-started
	// shell mid-init, dropping the auto-typed `glab auth login` bytes.
	const onExitRef = useRef(onExit);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onExitRef.current = onExit;
		onErrorRef.current = onError;
	}, [onExit, onError]);

	// Auto-focus the xterm viewport on activation (RAF-deferred so the
	// slot's height transition + xterm's textarea attach finish first;
	// matches the inspector terminal pattern). Inline-calling
	// `.focus()` from the spawn effect raced the layout and silently
	// did nothing.
	useEffect(() => {
		if (!active || !terminal) return;
		const id = requestAnimationFrame(() => {
			termRef.current?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [active, terminal]);

	useEffect(() => {
		if (!active || !terminal) return;

		let cancelled = false;
		const replay = () => {
			termRef.current?.clear();
			termRef.current?.refit();
		};

		if (termRef.current) replay();
		else requestAnimationFrame(replay);

		void spawnForgeCliAuthTerminal(
			terminal.provider,
			terminal.host,
			terminal.instanceId,
			(event: ScriptEvent) => {
				if (cancelled) return;
				switch (event.type) {
					case "stdout":
					case "stderr":
						termRef.current?.write(event.data);
						break;
					case "error":
						termRef.current?.write(`\r\n${event.message}\r\n`);
						onErrorRef.current(event.message);
						break;
					case "exited":
						onExitRef.current(event.code);
						break;
					case "started":
						break;
				}
			},
		).catch((error) => {
			if (cancelled) return;
			const message =
				error instanceof Error ? error.message : "Unable to start login.";
			termRef.current?.write(`\r\n${message}\r\n`);
			onErrorRef.current(message);
		});

		return () => {
			cancelled = true;
			void stopForgeCliAuthTerminal(
				terminal.provider,
				terminal.host,
				terminal.instanceId,
			);
		};
	}, [active, terminal]);

	const handleData = useCallback(
		(data: string) => {
			if (!terminal) return;
			void writeForgeCliAuthTerminalStdin(
				terminal.provider,
				terminal.host,
				terminal.instanceId,
				data,
			);
		},
		[terminal],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (!terminal) return;
			void resizeForgeCliAuthTerminal(
				terminal.provider,
				terminal.host,
				terminal.instanceId,
				cols,
				rows,
			);
		},
		[terminal],
	);

	if (!terminal) return null;

	const title =
		terminal.provider === "gitlab"
			? `glab auth login · ${terminal.host}`
			: "gh auth login";

	return (
		<OnboardingTerminalPreview
			title={title}
			active={active}
			terminalRef={termRef}
			heightClassName="h-[258px]"
			terminalClassName="h-[218px]"
			panelClassName="shadow-none"
			className="!relative !top-auto !right-auto !w-full !translate-y-0"
			onData={handleData}
			onResize={handleResize}
			onClose={onClose}
		/>
	);
}

function normalizeGitlabHost(value: string) {
	return value
		.trim()
		.replace(/^https?:\/\//i, "")
		.split("/")[0]
		.trim();
}
