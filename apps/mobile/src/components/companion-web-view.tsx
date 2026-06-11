import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import type {
	WebViewErrorEvent,
	WebViewHttpErrorEvent,
	WebViewMessageEvent,
	WebViewNavigation,
	WebViewNavigationEvent,
} from "react-native-webview/lib/WebViewTypes";
import type { NativePairing } from "../lib/pairing";
import { useThemedStyles } from "../lib/use-themed-styles";
import {
	companionBootstrapScript,
	companionNativeSafeAreaScript,
	companionWebViewUrl,
} from "../lib/webview-bootstrap";
import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";
import { PrimaryButton } from "./primary-button";

type CompanionWebViewProps = {
	pairing: NativePairing;
	onForget: () => void;
};

const TOP_SAFE_AREA_COMPRESSION = 12;
const BOTTOM_SAFE_AREA_COMPRESSION = 12;
const LOG_PREFIX = "[helmor-mobile:webview]";

export function CompanionWebView({ pairing, onForget }: CompanionWebViewProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const webViewRef = useRef<WebView>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pageBackgroundColor, setPageBackgroundColor] = useState(
		theme.colors.bg,
	);
	const nativeSafeArea = useMemo(
		() => ({
			bottom: Math.max(insets.bottom - BOTTOM_SAFE_AREA_COMPRESSION, 0),
			top: Math.max(insets.top - TOP_SAFE_AREA_COMPRESSION, 0),
		}),
		[insets.bottom, insets.top],
	);
	const bootstrapScript = useMemo(
		() => companionBootstrapScript(pairing, nativeSafeArea),
		[pairing, nativeSafeArea],
	);
	const sourceUri = useMemo(() => companionWebViewUrl(pairing), [pairing]);
	const pageBackgroundStyle = useMemo(
		() => ({ backgroundColor: pageBackgroundColor }),
		[pageBackgroundColor],
	);

	useEffect(() => {
		logWebView("mount", {
			baseUrl: pairing.baseUrl,
			sourceUri: sanitizeUrl(sourceUri),
			token: tokenSummary(pairing.token),
		});
	}, [pairing.baseUrl, pairing.token, sourceUri]);

	useEffect(() => {
		setPageBackgroundColor(theme.colors.bg);
	}, [theme.colors.bg, pairing.baseUrl]);

	useEffect(() => {
		webViewRef.current?.injectJavaScript(
			companionNativeSafeAreaScript(nativeSafeArea),
		);
	}, [nativeSafeArea]);

	const retry = () => {
		logWebView("retry", { sourceUri: sanitizeUrl(sourceUri) });
		setError(null);
		setIsLoading(true);
		webViewRef.current?.reload();
	};

	const handleMessage = (event: WebViewMessageEvent) => {
		const diagnostic = parseDiagnosticMessage(event.nativeEvent.data);
		if (diagnostic) {
			logWebView(diagnostic.message, diagnostic.details, diagnostic.level);
			return;
		}
		const nextBackgroundColor = parseBackgroundColorMessage(
			event.nativeEvent.data,
		);
		if (nextBackgroundColor) {
			logWebView("background-color", { value: nextBackgroundColor });
			setPageBackgroundColor(nextBackgroundColor);
		}
	};

	const handleLoadStart = (event: WebViewNavigationEvent) => {
		logWebView("loadStart", navigationSummary(event.nativeEvent));
		setError(null);
		setIsLoading(true);
	};

	const handleLoadEnd = (event: WebViewNavigationEvent | WebViewErrorEvent) => {
		logWebView("loadEnd", navigationSummary(event.nativeEvent));
		setIsLoading(false);
	};

	const handleLoad = (event: WebViewNavigationEvent) => {
		logWebView("load", navigationSummary(event.nativeEvent));
	};

	const handleNavigationStateChange = (navigation: WebViewNavigation) => {
		logWebView("navigationStateChange", navigationSummary(navigation));
	};

	const handleHttpError = (event: WebViewHttpErrorEvent) => {
		logWebView(
			"httpError",
			{
				...navigationSummary(event.nativeEvent),
				statusCode: event.nativeEvent.statusCode,
				description: event.nativeEvent.description,
			},
			"warn",
		);
	};

	const handleError = (event: WebViewErrorEvent) => {
		logWebView("error", navigationSummary(event.nativeEvent), "error");
		setIsLoading(false);
		setError(event.nativeEvent.description || "Unable to load Helmor.");
	};

	return (
		<View style={[styles.container, pageBackgroundStyle]}>
			<View style={[styles.content, pageBackgroundStyle]}>
				<WebView
					ref={webViewRef}
					allowsBackForwardNavigationGestures={false}
					allowsInlineMediaPlayback
					allowsLinkPreview={false}
					automaticallyAdjustContentInsets={false}
					automaticallyAdjustsScrollIndicatorInsets={false}
					bounces={false}
					cacheEnabled
					contentInset={{ top: 0, left: 0, bottom: 0, right: 0 }}
					contentInsetAdjustmentBehavior="never"
					contentMode="mobile"
					dataDetectorTypes="none"
					decelerationRate="normal"
					domStorageEnabled
					injectedJavaScript={bootstrapScript}
					injectedJavaScriptBeforeContentLoaded={bootstrapScript}
					javaScriptEnabled
					onContentProcessDidTerminate={() => {
						logWebView(
							"contentProcessDidTerminate",
							{ sourceUri: sanitizeUrl(sourceUri) },
							"error",
						);
						setIsLoading(false);
						setError("Helmor WebView process terminated.");
					}}
					onError={handleError}
					onHttpError={handleHttpError}
					onLoad={handleLoad}
					onLoadEnd={handleLoadEnd}
					onLoadStart={handleLoadStart}
					onMessage={handleMessage}
					onNavigationStateChange={handleNavigationStateChange}
					onShouldStartLoadWithRequest={(request) =>
						loggedAllowedNavigation(request.url, pairing.baseUrl)
					}
					originWhitelist={["http://*", "https://*", "about:*"]}
					pullToRefreshEnabled={false}
					scalesPageToFit={false}
					setSupportMultipleWindows={false}
					sharedCookiesEnabled
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
					source={{ uri: sourceUri }}
					style={[styles.webView, pageBackgroundStyle]}
				/>

				{isLoading && !error ? (
					<View
						pointerEvents="none"
						style={[styles.loading, pageBackgroundStyle]}
					>
						<ActivityIndicator color={theme.colors.text} />
						<Text style={styles.loadingText}>Opening Helmor</Text>
					</View>
				) : null}

				{error ? (
					<View style={[styles.errorPanel, pageBackgroundStyle]}>
						<Text style={styles.errorTitle}>Connection interrupted</Text>
						<Text selectable style={styles.errorCopy}>
							{error}
						</Text>
						<View style={styles.errorActions}>
							<PrimaryButton label="Retry" onPress={retry} />
							<PrimaryButton
								label="Scan again"
								onPress={onForget}
								tone="secondary"
							/>
						</View>
					</View>
				) : null}
			</View>
		</View>
	);
}

function logWebView(
	message: string,
	details?: Record<string, unknown> | null,
	level: "info" | "warn" | "error" = "info",
) {
	const logger =
		level === "error"
			? console.error
			: level === "warn"
				? console.warn
				: console.log;
	logger(`${LOG_PREFIX} ${message}`, sanitizeDetails(details ?? {}));
}

function tokenSummary(token: string): string {
	return `${token.length} chars, suffix=${token.slice(-4)}`;
}

function navigationSummary(event: {
	url?: string;
	title?: string;
	loading?: boolean;
	canGoBack?: boolean;
	canGoForward?: boolean;
	code?: number;
	description?: string;
}): Record<string, unknown> {
	return {
		url: sanitizeUrl(event.url),
		title: event.title,
		loading: event.loading,
		canGoBack: event.canGoBack,
		canGoForward: event.canGoForward,
		code: event.code,
		description: event.description,
	};
}

function loggedAllowedNavigation(url: string, baseUrl: string): boolean {
	const allowed = isAllowedNavigation(url, baseUrl);
	logWebView("shouldStartLoad", { url: sanitizeUrl(url), baseUrl, allowed });
	return allowed;
}

function sanitizeUrl(url: string | undefined): string | undefined {
	if (!url) return url;
	return url
		.replace(/([#?&](?:pair|token)=)[^&#]+/gi, "$1<redacted>")
		.replace(/([?&]baseUrl=)[^&#]+/gi, "$1<redacted-base-url>");
}

function sanitizeDetails(value: unknown): unknown {
	if (typeof value === "string") return sanitizeUrl(value) ?? value;
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sanitizeDetails);
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = sanitizeDetails(entry);
	}
	return result;
}

function parseDiagnosticMessage(data: string): {
	level: "info" | "warn" | "error";
	message: string;
	details: Record<string, unknown> | null;
} | null {
	try {
		const message = JSON.parse(data) as {
			type?: unknown;
			level?: unknown;
			message?: unknown;
			details?: unknown;
		};
		if (message.type !== "helmor:webview-diagnostic") return null;
		const level =
			message.level === "warn" || message.level === "error"
				? message.level
				: "info";
		return {
			level,
			message:
				typeof message.message === "string" ? message.message : "diagnostic",
			details:
				message.details && typeof message.details === "object"
					? (message.details as Record<string, unknown>)
					: null,
		};
	} catch {
		return null;
	}
}

function parseBackgroundColorMessage(data: string): string | null {
	try {
		const message = JSON.parse(data) as {
			type?: unknown;
			value?: unknown;
		};
		if (message.type !== "helmor:background-color") return null;
		if (typeof message.value !== "string") return null;
		const color = message.value.trim();
		if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
		if (/^rgba?\(\s*\d{1,3}\s*,/.test(color)) return color;
		return null;
	} catch {
		return null;
	}
}

function isAllowedNavigation(url: string, baseUrl: string): boolean {
	if (url === "about:blank" || url.startsWith("about:")) return true;
	try {
		return new URL(url).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		container: {
			backgroundColor: theme.colors.bg,
			flex: 1,
		},
		content: {
			backgroundColor: theme.colors.bg,
			flex: 1,
			overflow: "hidden",
		},
		webView: {
			backgroundColor: theme.colors.bg,
			flex: 1,
		},
		loading: {
			alignItems: "center",
			backgroundColor: theme.colors.bg,
			bottom: 0,
			gap: theme.spacing.sm,
			justifyContent: "center",
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
		},
		loadingText: {
			color: theme.colors.textMuted,
			fontSize: theme.text.body,
			letterSpacing: 0,
		},
		errorPanel: {
			alignItems: "center",
			backgroundColor: theme.colors.bg,
			bottom: 0,
			justifyContent: "center",
			left: 0,
			paddingHorizontal: theme.spacing.xl,
			position: "absolute",
			right: 0,
			top: 0,
		},
		errorTitle: {
			color: theme.colors.text,
			fontSize: 22,
			fontWeight: "800",
			letterSpacing: 0,
			textAlign: "center",
		},
		errorCopy: {
			color: theme.colors.textMuted,
			fontSize: theme.text.title,
			lineHeight: 22,
			marginBottom: theme.spacing.lg,
			marginTop: theme.spacing.sm,
			textAlign: "center",
		},
		errorActions: {
			gap: theme.spacing.sm,
			width: "100%",
		},
	});
}
