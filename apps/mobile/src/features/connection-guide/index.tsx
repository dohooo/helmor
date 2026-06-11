import { StatusBar } from "expo-status-bar";
import { useVideoPlayer, VideoView } from "expo-video";
import {
	ActivityIndicator,
	Image,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemedStyles } from "../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../theme";

type ConnectionGuideProps = {
	busy: boolean;
	error: string | null;
	onOpenScanner: () => void;
};

const HELMOR_ICON = require("../../../assets/icon.png");
const GUIDE_VIDEO = require("../../../assets/connection-guide/desktop-pairing-guide.mp4");
const GRID_LINES = Array.from({ length: 18 }, (_, index) => index);
const GUIDE_VIDEO_ASPECT_RATIO = 1068 / 720;

export function ConnectionGuide({
	busy,
	error,
	onOpenScanner,
}: ConnectionGuideProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const { height, width } = useWindowDimensions();
	const isShortScreen = height < 760;
	const isVeryShortScreen = height < 700;
	const player = useVideoPlayer(GUIDE_VIDEO, (videoPlayer) => {
		videoPlayer.loop = true;
		videoPlayer.muted = true;
		videoPlayer.allowsExternalPlayback = false;
		videoPlayer.play();
	});

	return (
		<View style={styles.root}>
			<StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
			<GridBackground />
			<View
				style={[
					styles.content,
					isShortScreen && styles.compactContent,
					isVeryShortScreen && styles.veryCompactContent,
					{
						minHeight: height,
						paddingTop:
							Math.max(insets.top, 16) + (isVeryShortScreen ? 12 : 24),
						paddingBottom: Math.max(insets.bottom, 16) + 12,
					},
				]}
			>
				<View style={styles.brand}>
					<Image
						accessibilityIgnoresInvertColors
						source={HELMOR_ICON}
						style={styles.brandIcon}
					/>
					<Text style={styles.brandText}>Helmor</Text>
				</View>

				<View style={styles.heroCopy}>
					<Text style={styles.title}>Connect to Desktop</Text>
					<Text style={styles.subtitle}>
						Open Helmor Desktop and scan the QR code.
					</Text>
				</View>

				<View
					style={[
						styles.videoCard,
						{
							height: width / GUIDE_VIDEO_ASPECT_RATIO,
							width,
						},
					]}
				>
					<VideoView
						allowsPictureInPicture={false}
						allowsVideoFrameAnalysis={false}
						contentFit="contain"
						fullscreenOptions={{ enable: false }}
						nativeControls={false}
						player={player}
						playsInline
						startsPictureInPictureAutomatically={false}
						style={styles.video}
					/>
				</View>

				<Pressable
					accessibilityRole="button"
					accessibilityState={{ disabled: busy }}
					disabled={busy}
					hitSlop={8}
					onPress={onOpenScanner}
					style={({ pressed }) => [
						styles.scanButton,
						pressed && !busy && styles.scanButtonPressed,
						busy && styles.scanButtonDisabled,
					]}
				>
					{busy ? (
						<ActivityIndicator color={theme.colors.accentText} />
					) : (
						<ScanIcon />
					)}
					<Text style={styles.scanButtonText}>Scan QR Code</Text>
				</Pressable>

				{error ? (
					<View style={styles.errorBanner}>
						<Text selectable style={styles.errorText}>
							{error}
						</Text>
					</View>
				) : null}
			</View>
		</View>
	);
}

function GridBackground() {
	const styles = useThemedStyles(createStyles);

	return (
		<View pointerEvents="none" style={styles.grid}>
			{GRID_LINES.map((line) => (
				<View
					key={`v-${line}`}
					style={[styles.gridLineVertical, { left: `${line * 6}%` }]}
				/>
			))}
			{GRID_LINES.map((line) => (
				<View
					key={`h-${line}`}
					style={[styles.gridLineHorizontal, { top: `${line * 6}%` }]}
				/>
			))}
		</View>
	);
}

function ScanIcon() {
	const styles = useThemedStyles(createStyles);

	return (
		<View style={styles.scanIcon}>
			<View style={[styles.scanCorner, styles.scanCornerTopLeft]} />
			<View style={[styles.scanCorner, styles.scanCornerTopRight]} />
			<View style={[styles.scanCorner, styles.scanCornerBottomLeft]} />
			<View style={[styles.scanCorner, styles.scanCornerBottomRight]} />
		</View>
	);
}

function createStyles(theme: HelmorTheme) {
	const isDark = theme.mode === "dark";

	return StyleSheet.create({
		root: {
			backgroundColor: isDark ? "#030303" : "#ffffff",
			flex: 1,
		},
		content: {
			alignItems: "center",
			flex: 1,
			gap: 14,
			justifyContent: "flex-start",
			paddingHorizontal: 0,
		},
		compactContent: {
			gap: 11,
			justifyContent: "flex-start",
		},
		veryCompactContent: {
			gap: 9,
		},
		grid: {
			bottom: 0,
			left: 0,
			opacity: isDark ? 0.42 : 0.55,
			position: "absolute",
			right: 0,
			top: 0,
		},
		gridLineVertical: {
			backgroundColor: isDark
				? "rgba(255, 255, 255, 0.035)"
				: "rgba(10, 10, 10, 0.035)",
			bottom: 0,
			position: "absolute",
			top: 0,
			width: StyleSheet.hairlineWidth,
		},
		gridLineHorizontal: {
			backgroundColor: isDark
				? "rgba(255, 255, 255, 0.035)"
				: "rgba(10, 10, 10, 0.035)",
			height: StyleSheet.hairlineWidth,
			left: 0,
			position: "absolute",
			right: 0,
		},
		brand: {
			alignItems: "center",
			flexDirection: "row",
			gap: 7,
			justifyContent: "center",
		},
		brandIcon: {
			borderRadius: 6,
			height: 22,
			width: 22,
		},
		brandText: {
			color: theme.colors.text,
			fontSize: 18,
			fontWeight: "800",
			letterSpacing: 0,
		},
		heroCopy: {
			alignItems: "center",
			gap: 5,
		},
		title: {
			color: theme.colors.text,
			fontSize: 24,
			fontWeight: "800",
			letterSpacing: 0,
			lineHeight: 28,
			textAlign: "center",
		},
		subtitle: {
			color: isDark ? "rgba(255, 255, 255, 0.68)" : "rgba(24, 24, 27, 0.72)",
			fontSize: 13,
			fontWeight: "500",
			letterSpacing: 0,
			lineHeight: 19,
			textAlign: "center",
		},
		videoCard: {
			backgroundColor: isDark ? "#050505" : "#f4f4f5",
			overflow: "hidden",
		},
		video: {
			flex: 1,
		},
		scanButton: {
			alignItems: "center",
			backgroundColor: isDark
				? "rgba(255, 255, 255, 0.10)"
				: "rgba(24, 24, 27, 0.06)",
			borderColor: isDark
				? "rgba(255, 255, 255, 0.16)"
				: "rgba(24, 24, 27, 0.10)",
			borderCurve: "continuous",
			borderRadius: 999,
			borderWidth: 1,
			boxShadow: isDark
				? "0 8px 18px rgba(0, 0, 0, 0.24)"
				: "0 8px 18px rgba(24, 24, 27, 0.08)",
			flexDirection: "row",
			gap: 8,
			justifyContent: "center",
			minHeight: 42,
			paddingHorizontal: 18,
		},
		scanButtonPressed: {
			transform: [{ scale: 0.985 }],
		},
		scanButtonDisabled: {
			opacity: 0.62,
		},
		scanButtonText: {
			color: theme.colors.text,
			fontSize: 15,
			fontWeight: "700",
			letterSpacing: 0,
		},
		scanIcon: {
			height: 18,
			position: "relative",
			width: 18,
		},
		scanCorner: {
			borderColor: theme.colors.text,
			height: 7,
			position: "absolute",
			width: 7,
		},
		scanCornerTopLeft: {
			borderLeftWidth: 2,
			borderTopWidth: 2,
			left: 0,
			top: 0,
		},
		scanCornerTopRight: {
			borderRightWidth: 2,
			borderTopWidth: 2,
			right: 0,
			top: 0,
		},
		scanCornerBottomLeft: {
			borderBottomWidth: 2,
			borderLeftWidth: 2,
			bottom: 0,
			left: 0,
		},
		scanCornerBottomRight: {
			borderBottomWidth: 2,
			borderRightWidth: 2,
			bottom: 0,
			right: 0,
		},
		errorBanner: {
			backgroundColor: isDark
				? "rgba(251, 113, 133, 0.12)"
				: "rgba(220, 38, 38, 0.08)",
			borderColor: isDark
				? "rgba(251, 113, 133, 0.26)"
				: "rgba(220, 38, 38, 0.18)",
			borderCurve: "continuous",
			borderRadius: 14,
			borderWidth: 1,
			maxWidth: 520,
			paddingHorizontal: 14,
			paddingVertical: 10,
			width: "92%",
		},
		errorText: {
			color: theme.colors.danger,
			fontSize: theme.text.body,
			fontWeight: "600",
			letterSpacing: 0,
			lineHeight: 20,
			textAlign: "center",
		},
	});
}
