import { MarkGithubIcon } from "@primer/octicons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import helmorLogoSrc from "@/assets/helmor-logo.png";
import bannerHtml from "@/assets/render-banner.html?raw";
import { Button } from "@/components/ui/button";
import { TypingAnimation } from "@/components/ui/typing-animation";
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
			<iframe
				title="Helmor branding animation"
				srcDoc={bannerHtml}
				aria-hidden
				tabIndex={-1}
				className="pointer-events-none absolute inset-0 z-0 h-full w-full border-0 bg-transparent opacity-[0.02]"
			/>
			<div
				aria-label="GitHub identity gate drag region"
				className="absolute inset-x-0 top-0 z-10 flex h-11 items-center"
			>
				<div data-tauri-drag-region className="h-full w-[94px] shrink-0" />
				<div data-tauri-drag-region className="h-full flex-1" />
			</div>

			<div className="relative z-10 flex h-full items-center justify-center px-6">
				<div className="flex w-full max-w-md flex-col items-center">
					<img
						src={helmorLogoSrc}
						alt="Helmor"
						draggable={false}
						className="size-18 rounded-[11px] opacity-90"
					/>

					{identityState.status === "awaiting-redirect" ? (
						<div className="mt-10 flex flex-col items-center gap-3">
							<div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
								<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
								Waiting for authorization
							</div>
							<Button variant="ghost" size="sm" onClick={onCancelGithubConnect}>
								Cancel
							</Button>
						</div>
					) : identityState.status === "pending" ? (
						<div className="mt-10 flex w-full max-w-xs flex-col items-center gap-4">
							<Button
								variant="outline"
								size="lg"
								onClick={() => {
									void handleCopyCodeThenRedirect();
								}}
								disabled={codeCopied}
								aria-label="Copy one-time code"
								title="Copy one-time code"
								className="h-auto w-full justify-center gap-3 py-4"
							>
								<span className="font-mono text-2xl font-medium tracking-[0.25em] text-foreground">
									{identityState.flow.userCode}
								</span>
								{codeCopied ? (
									<Check
										data-icon="inline-end"
										className="size-4 text-emerald-500"
										strokeWidth={2.5}
									/>
								) : (
									<Copy
										data-icon="inline-end"
										className="size-4 text-muted-foreground"
										strokeWidth={1.8}
									/>
								)}
							</Button>
							<Button variant="ghost" size="sm" onClick={onCancelGithubConnect}>
								Cancel
							</Button>
						</div>
					) : identityState.status === "unconfigured" ? (
						<div className="mt-10 flex justify-center">
							<Button disabled size="lg">
								<MarkGithubIcon size={16} data-icon="inline-start" />
								Continue with GitHub
							</Button>
						</div>
					) : identityState.status === "checking" ? (
						<div className="mt-10 inline-flex items-center justify-center gap-2 text-sm text-muted-foreground">
							<RefreshCw className="size-4 animate-spin" strokeWidth={1.8} />
							Restoring your last session
						</div>
					) : (
						<div className="mt-10 flex justify-center">
							<Button
								onClick={onConnectGithub}
								size="lg"
								className="hover:bg-primary/90"
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

			<figure className="absolute inset-x-0 bottom-16 z-10 flex items-baseline justify-center gap-2 px-6">
				<span
					aria-hidden
					className="font-serif text-3xl leading-none text-muted-foreground/40"
				>
					&ldquo;
				</span>
				<blockquote className="whitespace-nowrap font-serif text-lg italic leading-snug text-foreground/70">
					<TypingAnimation
						text={[
							{ text: "AI made me 10x. " },
							{
								text: "Helmor",
								className: "font-bold text-foreground",
							},
							{
								text: " takes me 100x. Goodbye, handcrafted code. 👋",
							},
						]}
						duration={55}
						delay={400}
					/>
				</blockquote>
			</figure>
		</main>
	);
}
