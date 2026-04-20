import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	ChevronDown,
	Loader2,
	LogIn,
	Mail,
	ShieldAlert,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type ClaudeDesignCookieSource,
	type ClaudeDesignOAuthInterceptedPayload,
	type ClaudeDesignViewBounds,
	hideClaudeDesignView,
	importClaudeDesignCookies,
	openClaudeDesignView,
	setClaudeDesignViewBounds,
} from "@/lib/api";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

/**
 * ClaudeDesignView — full-window takeover that embeds `https://claude.ai/design`
 * via a Tauri child `Webview` (WKWebView on macOS).
 *
 * Layout: a thin top header (traffic-light spacer + drag region + close `X`)
 * and below it a full-bleed placeholder `<div>` whose bounding rect we push
 * to Rust, so the native child webview paints exactly over it.
 *
 * Lifecycle: mount → open (or re-show) the child webview; unmount → hide it.
 * Using `hide` instead of `close` means the native WKWebView instance
 * survives across X → reopen cycles, so login state, scroll position, and
 * the loaded page are preserved.
 *
 * ## OAuth intercept (why the Google button has a modal)
 *
 * Google Identity Services refuses to auth in any embedded WebView. The
 * Rust backend catches GSI's `window.open(...)` popup via `on_new_window`,
 * denies it, and emits `claude-design-oauth-intercepted`. We hide the
 * webview, show a modal with two paths:
 *   - Use email sign-in — dismiss, restore webview, user uses the email
 *     input already on the claude.ai login page.
 *   - Import login from <Browser> — pull cookies from the user's real
 *     desktop browser via `rookie` and inject them into the embedded
 *     webview. If no cookies are found we auto-open the site in the user's
 *     default browser so they can sign in there first, then retry.
 */

const COOKIE_SOURCE_BROWSERS: {
	id: ClaudeDesignCookieSource;
	label: string;
}[] = [
	{ id: "chrome", label: "Chrome" },
	{ id: "arc", label: "Arc" },
	{ id: "brave", label: "Brave" },
	{ id: "edge", label: "Edge" },
	{ id: "firefox", label: "Firefox" },
];

const CLAUDE_DESIGN_URL = "https://claude.ai/design";

export const ClaudeDesignView = memo(function ClaudeDesignView({
	onClose,
}: {
	onClose: () => void;
}) {
	const placeholderRef = useRef<HTMLDivElement | null>(null);
	const lastBoundsRef = useRef<ClaudeDesignViewBounds | null>(null);
	const openedRef = useRef(false);
	const [interceptedHost, setInterceptedHost] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const pushToast = useWorkspaceToast();

	const measureAndSync = useCallback((mode: "open" | "update") => {
		const el = placeholderRef.current;
		if (!el) {
			return;
		}
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return;
		}
		const bounds: ClaudeDesignViewBounds = {
			x: Math.round(rect.left),
			y: Math.round(rect.top),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		};

		const last = lastBoundsRef.current;
		if (
			mode === "update" &&
			last &&
			last.x === bounds.x &&
			last.y === bounds.y &&
			last.width === bounds.width &&
			last.height === bounds.height
		) {
			return;
		}
		lastBoundsRef.current = bounds;

		if (mode === "open" || !openedRef.current) {
			openedRef.current = true;
			void openClaudeDesignView(bounds).catch((error) => {
				console.error("Failed to open Claude Design view:", error);
			});
		} else {
			void setClaudeDesignViewBounds(bounds).catch((error) => {
				console.error("Failed to update Claude Design view bounds:", error);
			});
		}
	}, []);

	useEffect(() => {
		measureAndSync("open");

		const el = placeholderRef.current;
		if (!el) {
			return;
		}

		const ro = new ResizeObserver(() => measureAndSync("update"));
		ro.observe(el);

		const onResize = () => measureAndSync("update");
		const onScroll = () => measureAndSync("update");
		window.addEventListener("resize", onResize);
		window.addEventListener("scroll", onScroll, true);

		return () => {
			ro.disconnect();
			window.removeEventListener("resize", onResize);
			window.removeEventListener("scroll", onScroll, true);
			// Hide instead of close — the next open will re-show the same
			// webview instance with its login state / page position intact.
			void hideClaudeDesignView().catch((error) => {
				console.error("Failed to hide Claude Design view:", error);
			});
		};
	}, [measureAndSync]);

	// OAuth intercept listener. On intercept we hide the webview so the
	// modal becomes visible in the same slot (the native WKWebView would
	// otherwise paint on top of any React UI).
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		void listen<ClaudeDesignOAuthInterceptedPayload>(
			"claude-design-oauth-intercepted",
			(event) => {
				setInterceptedHost(event.payload.host);
				void hideClaudeDesignView().catch((error) => {
					console.error(
						"Failed to hide Claude Design view on intercept:",
						error,
					);
				});
			},
		)
			.then((fn) => {
				if (cancelled) {
					fn();
					return;
				}
				unlisten = fn;
			})
			.catch((error) => {
				console.error(
					"Failed to listen for claude-design-oauth-intercepted:",
					error,
				);
			});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	const dismissModalAndRestoreWebview = useCallback(() => {
		setInterceptedHost(null);
		// Re-show the webview by running the open path again — Rust handles
		// the "already exists → show" case idempotently.
		const el = placeholderRef.current;
		if (!el) {
			return;
		}
		const rect = el.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			const bounds: ClaudeDesignViewBounds = {
				x: Math.round(rect.left),
				y: Math.round(rect.top),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			};
			void openClaudeDesignView(bounds).catch((error) => {
				console.error("Failed to re-show Claude Design view:", error);
			});
		}
	}, []);

	const handleImport = useCallback(
		async (browser: ClaudeDesignCookieSource, browserLabel: string) => {
			setImporting(true);
			try {
				const result = await importClaudeDesignCookies(browser);
				if (result.imported === 0) {
					// No session cookies yet — user hasn't signed in to claude.ai
					// in this browser. Open claude.ai there so they can, then
					// come back and retry.
					pushToast(
						`Opening claude.ai in ${browserLabel} so you can sign in. Once you're signed in there, click "Import login" again.`,
						"Sign in to claude.ai first",
					);
					void openUrl(CLAUDE_DESIGN_URL).catch((error) => {
						console.error("Failed to open claude.ai in system browser:", error);
					});
					return;
				}
				pushToast(
					`Imported ${result.imported} cookie${result.imported === 1 ? "" : "s"} from ${browserLabel}.`,
					"Signed in",
				);
				// Cookies are injected + webview reloaded by the Rust command.
				dismissModalAndRestoreWebview();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pushToast(message, `Import from ${browserLabel} failed`, "destructive");
			} finally {
				setImporting(false);
			}
		},
		[dismissModalAndRestoreWebview, pushToast],
	);

	return (
		<div className="fixed inset-0 z-[100] flex flex-col bg-background">
			<header className="flex h-9 shrink-0 items-center border-b border-border pr-2">
				<TrafficLightSpacer side="left" width={94} />
				<div
					data-tauri-drag-region
					className="h-full flex-1"
					aria-hidden="true"
				/>
				<Button
					aria-label="Close Claude Design"
					variant="ghost"
					size="icon-xs"
					onClick={onClose}
					className="text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<X className="size-3.5" strokeWidth={2} />
				</Button>
			</header>
			<div className="relative flex min-h-0 flex-1 overflow-hidden">
				<div
					ref={placeholderRef}
					className="flex-1"
					aria-label="Claude Design viewport"
				/>
				{interceptedHost ? (
					<OAuthInterceptModal
						host={interceptedHost}
						importing={importing}
						onDismiss={dismissModalAndRestoreWebview}
						onImport={handleImport}
					/>
				) : null}
			</div>
		</div>
	);
});

function OAuthInterceptModal({
	host,
	importing,
	onDismiss,
	onImport,
}: {
	host: string;
	importing: boolean;
	onDismiss: () => void;
	onImport: (browser: ClaudeDesignCookieSource, label: string) => void;
}) {
	return (
		<div className="absolute inset-0 flex items-center justify-center bg-background px-8">
			<div className="w-full max-w-[460px] rounded-xl border border-border bg-card p-6 shadow-lg">
				<div className="mb-4 flex items-start gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
						<ShieldAlert className="size-4" strokeWidth={2} />
					</div>
					<div className="flex-1">
						<h2 className="text-[15px] font-semibold text-foreground">
							Google sign-in isn't available here
						</h2>
						<p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
							Google blocks OAuth inside embedded browsers, so{" "}
							<span className="font-medium text-foreground">{host}</span> can't
							complete the sign-in here. Pick one of the options below.
						</p>
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<Button
						variant="default"
						className="w-full justify-start gap-2"
						onClick={onDismiss}
						disabled={importing}
					>
						<Mail className="size-3.5" strokeWidth={2} />
						<span>Use email sign-in instead</span>
						<span className="ml-auto text-[11px] text-muted-foreground/80">
							Return to login
						</span>
					</Button>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								className="w-full justify-start gap-2"
								disabled={importing}
							>
								{importing ? (
									<Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
								) : (
									<LogIn className="size-3.5" strokeWidth={2} />
								)}
								<span>Import login from another browser</span>
								<ChevronDown className="ml-auto size-3.5" strokeWidth={2} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="z-[200] w-48">
							<DropdownMenuLabel>Source browser</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{COOKIE_SOURCE_BROWSERS.map(({ id, label }) => (
								<DropdownMenuItem key={id} onSelect={() => onImport(id, label)}>
									{label}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				<p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
					Not signed in to claude.ai in that browser yet? Pick it anyway — we'll
					open claude.ai there so you can sign in, then try again.
				</p>
			</div>
		</div>
	);
}
