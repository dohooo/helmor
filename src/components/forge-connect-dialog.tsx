//! Centered modal that hosts an in-app terminal running
//! `gh auth login` / `glab auth login`. Replaces the previous
//! "open macOS Terminal" path used by the inspector / settings
//! Connect surfaces. Onboarding's inline-slide terminal stays as-is —
//! it's a different visual treatment for a different stage.
//!
//! Lifecycle:
//!   - On open: snapshot the current login set, spawn the auth PTY.
//!   - User authenticates inside the dialog (or doesn't).
//!   - On close (X / Esc / backdrop): kill the PTY, fire one
//!     `listForgeLogins` probe, diff against the snapshot. A new
//!     login means we invalidate the forge caches + emit a toast;
//!     no delta means a silent close.
//!
//! No polling — the close event is the authoritative "user is done"
//! signal.

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	backfillForgeRepoBindings,
	type ForgeProvider,
	listForgeLogins,
	loadWorkspaceDetail,
	resizeForgeCliAuthTerminal,
	retryRepoForgeBinding,
	type ScriptEvent,
	spawnForgeCliAuthTerminal,
	stopForgeCliAuthTerminal,
	type WorkspaceDetail,
	writeForgeCliAuthTerminalStdin,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";

export type ForgeConnectDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	provider: ForgeProvider;
	host: string;
	/** Repo to force-rebind after a successful login. */
	repoId?: string | null;
	/** Workspace context — drives PR / forge-status / detail invalidations. */
	workspaceId?: string | null;
	/** Optional escape hatch fired after the standard refresh runs. */
	onConnected?: (info: {
		provider: ForgeProvider;
		host: string;
		login: string;
	}) => void;
	onCloseSettled?: (info: {
		provider: ForgeProvider;
		host: string;
		connected: boolean;
		login: string | null;
	}) => void;
};

type LoginProbeResult = {
	login: string | null;
};

/// The post-close handler probes the live login set once after the
/// terminal exits. Prefer a login that was not present at open time,
/// but fall back to any current login so re-authorizing the same
/// account still drives repo rebind + cache refresh.
async function detectLoginAfterClose(
	provider: ForgeProvider,
	host: string,
	baseline: Set<string>,
): Promise<LoginProbeResult> {
	try {
		const current = await listForgeLogins(provider, host, {
			forceRefresh: true,
		});
		const newLogin = current.find((login) => !baseline.has(login));
		return { login: newLogin ?? current[0] ?? null };
	} catch {
		return { login: null };
	}
}

function providerLabel(provider: ForgeProvider): string {
	if (provider === "github") return "GitHub";
	if (provider === "gitlab") return "GitLab";
	return "Forge";
}

function providerIcon(provider: ForgeProvider) {
	if (provider === "gitlab") {
		return <GitlabBrandIcon size={12} className="text-[#FC6D26]" />;
	}
	return <GithubBrandIcon size={12} />;
}

export function ForgeConnectDialog({
	open,
	onOpenChange,
	provider,
	host,
	repoId,
	workspaceId,
	onConnected,
	onCloseSettled,
}: ForgeConnectDialogProps) {
	const queryClient = useQueryClient();
	const termRef = useRef<TerminalHandle | null>(null);
	const baselineRef = useRef<Set<string>>(new Set());
	const instanceIdRef = useRef<string>("");
	const cleanedUpRef = useRef(false);

	// Allocate a fresh instance id each time the dialog opens — the
	// backend keys spawned PTYs by it, so reusing one across opens
	// would race with the previous session's stop.
	const [instanceId, setInstanceId] = useState<string>("");

	useEffect(() => {
		if (!open) return;
		const id =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `forge-connect-${Date.now()}`;
		instanceIdRef.current = id;
		cleanedUpRef.current = false;
		setInstanceId(id);
	}, [open]);

	// Snapshot the login set BEFORE spawning the terminal so the
	// post-close diff has a stable baseline. Failure to snapshot
	// (gh missing, IPC blip) → empty baseline; any login that ends up
	// present after close still counts as new.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void listForgeLogins(provider, host)
			.then((logins) => {
				if (!cancelled) baselineRef.current = new Set(logins);
			})
			.catch(() => {
				if (!cancelled) baselineRef.current = new Set();
			});
		return () => {
			cancelled = true;
		};
	}, [open, provider, host]);

	// Keep onOpenChange off the spawn effect's deps — parent re-renders
	// recreate the callback, and a re-run kills the just-started shell
	// mid-init via register's replace-by-key, dropping the auto-typed
	// `gh|glab auth login` bytes.
	const onOpenChangeRef = useRef(onOpenChange);

	// On close: stop the PTY, run the delta probe once, propagate
	// upwards. Wrapped in a ref-guarded block so multi-fire close
	// events (X click + Esc + backdrop in a single render cycle) only
	// run cleanup once.
	const handleClose = useCallback(async () => {
		if (cleanedUpRef.current) return;
		cleanedUpRef.current = true;
		const id = instanceIdRef.current;
		if (id) {
			try {
				await stopForgeCliAuthTerminal(provider, host, id);
			} catch {
				// Already exited / never spawned. Either way, move on.
			}
		}

		const probe = await detectLoginAfterClose(
			provider,
			host,
			baselineRef.current,
		);
		// Always invalidate the per-host login set so the lightweight
		// `useForgeLoginsHealth` probes in the inspector / settings
		// pick up the change immediately, no focus required.
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.forgeLogins(provider, host),
		});

		let connectedLogin = probe.login;
		if (probe.login) {
			// Resolve the repo to rebind: explicit prop wins, otherwise
			// pull from the workspace detail cache.
			let resolvedRepoId = repoId ?? null;
			if (!resolvedRepoId && workspaceId) {
				const detail = queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				);
				resolvedRepoId = detail?.repoId ?? null;
			}
			if (!resolvedRepoId && workspaceId) {
				try {
					const detail = await loadWorkspaceDetail(workspaceId);
					resolvedRepoId = detail?.repoId ?? null;
				} catch {
					resolvedRepoId = null;
				}
			}
			if (resolvedRepoId) {
				try {
					connectedLogin = await retryRepoForgeBinding(resolvedRepoId);
				} catch {
					connectedLogin = null;
				}
			} else if (repoId || workspaceId) {
				connectedLogin = null;
			}

			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.forgeAccountsAll,
			});
			// Match BOTH `workspaceForge` (detection) and
			// `workspaceForgeActionStatus` (the inspector header's
			// remote-state source).
			void queryClient.invalidateQueries({
				predicate: (q) => {
					const head = q.queryKey[0];
					return typeof head === "string" && head.startsWith("workspaceForge");
				},
			});
			if (workspaceId) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				});
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceChangeRequest(workspaceId),
				});
			}
			// Always invalidate — per-repo retry above may have changed
			// this repo's row, and the async backfill below may bind more.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			});
			void backfillForgeRepoBindings()
				.then((bound) => {
					if (bound > 0) {
						void queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.repositories,
						});
					}
				})
				.catch(() => {});
			if (connectedLogin) {
				toast.success(connectedToastMessage(provider, connectedLogin));
				onConnected?.({ provider, host, login: connectedLogin });
			}
		}
		onCloseSettled?.({
			provider,
			host,
			connected: connectedLogin !== null,
			login: connectedLogin,
		});
	}, [
		host,
		provider,
		onCloseSettled,
		onConnected,
		queryClient,
		repoId,
		workspaceId,
	]);

	useEffect(() => {
		onOpenChangeRef.current = (next) => {
			if (!next) {
				void handleClose();
			}
			onOpenChange(next);
		};
	}, [handleClose, onOpenChange]);

	// Auto-focus the xterm viewport so the user can start typing /
	// arrow through `gh auth login` prompts immediately. RAF-deferred
	// so the dialog's open animation + xterm's textarea attach
	// settle first; without the deferral, the inline focus raced
	// layout and silently did nothing.
	useEffect(() => {
		if (!open || !instanceId) return;
		const id = requestAnimationFrame(() => {
			termRef.current?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [open, instanceId]);

	// Spawn the auth PTY when the dialog opens; tear it down on close.
	useEffect(() => {
		if (!open || !instanceId) return;
		let cancelled = false;
		void spawnForgeCliAuthTerminal(
			provider,
			host,
			instanceId,
			(event: ScriptEvent) => {
				if (cancelled) return;
				switch (event.type) {
					case "stdout":
					case "stderr":
						termRef.current?.write(event.data);
						break;
					case "error":
						termRef.current?.write(`\r\n${event.message}\r\n`);
						break;
					case "exited":
						// Auth completed (or failed) — close the dialog so the
						// post-close handler runs the delta probe. Don't auto-
						// dismiss on non-zero exits either: the user might want
						// to read the error before closing.
						if (event.code === 0) onOpenChangeRef.current(false);
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
		});

		return () => {
			cancelled = true;
		};
	}, [open, provider, host, instanceId]);

	// Bridge Radix's onOpenChange (X / Esc / backdrop / programmatic)
	// into our cleanup handler.
	const handleOpenChange = useCallback((next: boolean) => {
		onOpenChangeRef.current(next);
	}, []);

	const onTerminalData = useCallback(
		(data: string) => {
			const id = instanceIdRef.current;
			if (!id) return;
			void writeForgeCliAuthTerminalStdin(provider, host, id, data);
		},
		[host, provider],
	);

	const onTerminalResize = useCallback(
		(cols: number, rows: number) => {
			const id = instanceIdRef.current;
			if (!id) return;
			void resizeForgeCliAuthTerminal(provider, host, id, cols, rows);
		},
		[host, provider],
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="w-[640px] max-w-[calc(100vw-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[640px]"
			>
				<DialogTitle className="sr-only">
					Connect {providerLabel(provider)}
				</DialogTitle>
				<header className="flex h-10 items-center gap-2 border-b border-border/55 px-3">
					<div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
						{providerIcon(provider)}
						<span>Connect {providerLabel(provider)}</span>
						{provider === "gitlab" ? (
							<span className="ml-1 text-muted-foreground/80">· {host}</span>
						) : null}
					</div>
					<div className="ml-auto">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => handleOpenChange(false)}
							aria-label="Close"
							className={cn(
								"gap-1.5 px-2 text-muted-foreground hover:text-foreground",
							)}
						>
							<ShortcutDisplay hotkey="Escape" />
							<X className="size-3.5" strokeWidth={1.8} />
						</Button>
					</div>
				</header>
				<div className="bg-card">
					<TerminalOutput
						terminalRef={termRef}
						className="h-[360px]"
						detectLinks
						fontSize={12}
						lineHeight={1.35}
						padding="12px 0 12px 16px"
						onData={onTerminalData}
						onResize={onTerminalResize}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function connectedToastMessage(provider: ForgeProvider, login: string): string {
	const label = providerLabel(provider);
	return login ? `${label} connected as @${login}` : `${label} connected`;
}
