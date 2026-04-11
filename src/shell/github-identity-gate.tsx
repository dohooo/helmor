import { MarkGithubIcon } from "@primer/octicons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GithubIdentityState } from "./types";

export function GithubIdentityGate({
	identityState,
	onConnectGithub,
	onCopyGithubCode,
	onCancelGithubConnect,
}: {
	identityState: GithubIdentityState;
	onConnectGithub: () => void;
	onCopyGithubCode: (userCode: string) => Promise<boolean>;
	onCancelGithubConnect: () => void;
}) {
	const [codeCopied, setCodeCopied] = useState(false);

	const title =
		identityState.status === "checking"
			? "Checking GitHub connection"
			: identityState.status === "awaiting-redirect"
				? "Waiting for GitHub authorization"
				: identityState.status === "pending"
					? "Finish sign-in on GitHub"
					: identityState.status === "unconfigured"
						? "GitHub account connection is not configured"
						: identityState.status === "error"
							? "GitHub connection failed"
							: "Sign in with GitHub";
	const description =
		identityState.status === "checking"
			? "Helmor is restoring your last GitHub account session."
			: identityState.status === "awaiting-redirect"
				? "Complete the sign-in in your browser. Helmor will update automatically."
				: identityState.status === "pending"
					? "Copy the code below, then you'll be redirected to GitHub to authorize."
					: identityState.status === "unconfigured"
						? identityState.message
						: identityState.status === "error"
							? identityState.message
							: "GitHub account connection is required before Helmor loads your workspaces.";

	const handleCopyCodeThenRedirect = useCallback(async () => {
		if (identityState.status !== "pending" || codeCopied) {
			return;
		}

		const copied = await onCopyGithubCode(identityState.flow.userCode);

		if (!copied) {
			return;
		}

		setCodeCopied(true);

		const { verificationUri, verificationUriComplete } = identityState.flow;

		setTimeout(() => {
			void (async () => {
				try {
					await openUrl(verificationUriComplete ?? verificationUri);
				} catch {
					// Keep the pending state visible even if the browser cannot be opened.
				}
			})();
		}, 600);
	}, [identityState, onCopyGithubCode, codeCopied]);

	return (
		<main
			aria-label="GitHub identity gate"
			className="relative h-screen overflow-hidden bg-background font-sans text-foreground antialiased"
		>
			<div
				aria-label="GitHub identity gate drag region"
				className="absolute inset-x-0 top-0 z-10 flex h-11 items-center"
			>
				<div data-tauri-drag-region className="h-full w-[94px] shrink-0" />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="relative flex h-full items-center justify-center px-6">
				<div className="w-full max-w-[31rem]">
					<h1 className="text-center text-[40px] leading-[1.04] tracking-[-0.04em] text-foreground">
						{title}
					</h1>
					<p className="mx-auto mt-4 max-w-[31rem] text-center text-[16px] leading-7 text-muted-foreground">
						{description}
					</p>

					{identityState.status === "awaiting-redirect" ? (
						<div className="mt-8 flex flex-col items-center gap-4">
							<div className="inline-flex items-center gap-2 text-[14px] text-muted-foreground">
								<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
								Waiting for authorization
							</div>
							<Button
								variant="ghost"
								onClick={onCancelGithubConnect}
								className="rounded-full px-4 text-[14px] text-muted-foreground hover:text-foreground"
							>
								Cancel
							</Button>
						</div>
					) : identityState.status === "pending" ? (
						<div className="mt-8 flex flex-col items-center gap-5">
							<Button
								variant="ghost"
								onClick={() => {
									void handleCopyCodeThenRedirect();
								}}
								disabled={codeCopied}
								className="relative h-auto rounded-2xl px-5 py-3 hover:bg-accent/60"
								aria-label="Copy one-time code"
								title="Copy one-time code"
							>
								<span className="font-mono text-[30px] tracking-[0.18em] text-foreground">
									{identityState.flow.userCode}
								</span>
								<span className="absolute -right-6 top-1/2 flex -translate-y-1/2 items-center justify-center">
									{codeCopied ? (
										<Check
											className="size-4 text-green-400"
											strokeWidth={2.5}
										/>
									) : (
										<Copy
											className="size-4 text-foreground/40"
											strokeWidth={1.8}
										/>
									)}
								</span>
							</Button>
							<div className="flex flex-wrap items-center justify-center gap-3">
								<Button
									variant="ghost"
									onClick={onCancelGithubConnect}
									className="rounded-full px-4 text-[14px] text-muted-foreground hover:text-foreground"
								>
									Cancel
								</Button>
							</div>
						</div>
					) : identityState.status === "unconfigured" ? (
						<div className="mt-8 flex justify-center">
							<Button
								disabled
								className="rounded-full px-4 text-[14px] opacity-70"
							>
								<MarkGithubIcon size={16} data-icon="inline-start" />
								Continue with GitHub
							</Button>
						</div>
					) : identityState.status === "checking" ? (
						<div className="mt-8 inline-flex w-full items-center justify-center gap-2 text-[14px] text-muted-foreground">
							<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
							Restoring your last session
						</div>
					) : (
						<div className="mt-8 flex justify-center">
							<Button
								onClick={onConnectGithub}
								className="rounded-full px-4 text-[14px]"
							>
								<MarkGithubIcon size={16} data-icon="inline-start" />
								{identityState.status === "error"
									? "Retry with GitHub"
									: "Continue with GitHub"}
							</Button>
						</div>
					)}
				</div>
			</div>
		</main>
	);
}
