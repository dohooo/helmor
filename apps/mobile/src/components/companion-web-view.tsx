import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import type {
	WebViewErrorEvent,
	WebViewMessageEvent,
} from "react-native-webview/lib/WebViewTypes";
import type { NativePairing } from "../lib/pairing";
import { useThemedStyles } from "../lib/use-themed-styles";
import {
	companionBootstrapScript,
	companionNativeSafeAreaScript,
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
	const pageBackgroundStyle = useMemo(
		() => ({ backgroundColor: pageBackgroundColor }),
		[pageBackgroundColor],
	);

	useEffect(() => {
		setPageBackgroundColor(theme.colors.bg);
	}, [theme.colors.bg, pairing.baseUrl]);

	useEffect(() => {
		webViewRef.current?.injectJavaScript(
			companionNativeSafeAreaScript(nativeSafeArea),
		);
	}, [nativeSafeArea]);

	const retry = () => {
		setError(null);
		setIsLoading(true);
		webViewRef.current?.reload();
	};

	const handleMessage = (event: WebViewMessageEvent) => {
		const nextBackgroundColor = parseBackgroundColorMessage(
			event.nativeEvent.data,
		);
		if (nextBackgroundColor) setPageBackgroundColor(nextBackgroundColor);
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
					onError={(event: WebViewErrorEvent) => {
						setIsLoading(false);
						setError(event.nativeEvent.description || "Unable to load Helmor.");
					}}
					onLoadEnd={() => setIsLoading(false)}
					onLoadStart={() => {
						setError(null);
						setIsLoading(true);
					}}
					onMessage={handleMessage}
					onShouldStartLoadWithRequest={(request) =>
						isAllowedNavigation(request.url, pairing.baseUrl)
					}
					originWhitelist={["http://*", "https://*", "about:*"]}
					pullToRefreshEnabled={false}
					scalesPageToFit={false}
					setSupportMultipleWindows={false}
					sharedCookiesEnabled
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
					source={{ uri: pairing.baseUrl }}
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
