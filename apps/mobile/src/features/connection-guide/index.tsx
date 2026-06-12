import { BlurView } from "expo-blur";
import { StatusBar } from "expo-status-bar";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect } from "react";
import {
	Image,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import Animated, {
	Easing,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GrainyGradient } from "../../components/ui";
import { useThemedStyles } from "../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../theme";
import { OnboardingCtaPanel } from "./components/onboarding-cta-panel";
import { CONNECTION_GUIDE_DISPLAY_FONT } from "./typography";

type ConnectionGuideProps = {
	busy: boolean;
	error: string | null;
	onOpenScanner: () => void;
};

const GUIDE_VIDEO = require("../../../assets/connection-guide/desktop-pairing-guide.mp4");
const HELMOR_ICON = require("../../../assets/icon.png");
const VIDEO_TRANSITION_SYNC_DELAY = 5500;

const HERO_WIDTH_RATIO = 0.96;
const HERO_MAX_WIDTH = 460;
const HERO_ASPECT_RATIO = 4 / 3;
const HERO_MAX_HEIGHT_RATIO = 0.34;
const HERO_FINAL_SCALE = 0.95;
const HERO_MOVE_DISTANCE_RATIO = 0.085;
const HERO_MOVE_DURATION = 760;
const CTA_ITEM_SEQUENCE_DELAY = VIDEO_TRANSITION_SYNC_DELAY;
const HERO_INITIAL_BOTTOM_OFFSET = 120;
const HERO_INITIAL_BOTTOM_OFFSET_COMPACT = 100;

export function ConnectionGuide({
	busy,
	error,
	onOpenScanner,
}: ConnectionGuideProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const { height, width } = useWindowDimensions();
	const heroProgress = useSharedValue(0);
	const heroMoveDistance = Math.round(height * HERO_MOVE_DISTANCE_RATIO);
	const heroWidth = Math.min(width * HERO_WIDTH_RATIO, HERO_MAX_WIDTH);
	const heroHeight = Math.min(
		heroWidth / HERO_ASPECT_RATIO,
		height * HERO_MAX_HEIGHT_RATIO,
	);
	const isShortScreen = height < 720;

	useEffect(() => {
		heroProgress.value = withDelay(
			VIDEO_TRANSITION_SYNC_DELAY,
			withTiming(1, {
				duration: HERO_MOVE_DURATION,
				easing: Easing.out(Easing.cubic),
			}),
		);
	}, [heroProgress]);

	const heroAnimatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateY: -heroMoveDistance * heroProgress.value },
			{ scale: 1 - (1 - HERO_FINAL_SCALE) * heroProgress.value },
		],
	}));

	return (
		<View
			style={[
				styles.root,
				{
					paddingBottom: Math.max(insets.bottom, 18),
					paddingTop: Math.max(insets.top, 16),
				},
			]}
		>
			<StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
			<BackgroundWash />

			<View style={styles.header}>
				<Image
					accessibilityIgnoresInvertColors
					source={HELMOR_ICON}
					style={styles.brandLogo}
				/>
				<Text style={styles.brand}>Helmor</Text>
			</View>

			<View style={[styles.stage, isShortScreen && styles.stageCompact]}>
				<Animated.View
					style={[
						styles.hero,
						{
							height: heroHeight,
							width: heroWidth,
						},
						heroAnimatedStyle,
					]}
				>
					<OnboardingVideoSurface />
				</Animated.View>

				<View style={styles.cta}>
					<OnboardingCtaPanel
						busy={busy}
						error={error}
						onScanPress={onOpenScanner}
						startDelay={CTA_ITEM_SEQUENCE_DELAY}
					/>
				</View>
			</View>
		</View>
	);
}

function OnboardingVideoSurface() {
	const styles = useThemedStyles(createStyles);
	const player = useVideoPlayer(GUIDE_VIDEO, (videoPlayer) => {
		videoPlayer.loop = true;
		videoPlayer.muted = true;
		videoPlayer.allowsExternalPlayback = false;
		videoPlayer.play();
	});

	return (
		<VideoView
			allowsPictureInPicture={false}
			allowsVideoFrameAnalysis={false}
			contentFit="cover"
			fullscreenOptions={{ enable: false }}
			nativeControls={false}
			player={player}
			playsInline
			startsPictureInPictureAutomatically={false}
			style={styles.video}
		/>
	);
}

function BackgroundWash() {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const isDark = theme.mode === "dark";
	const gradientColors: [string, string, string, string] = isDark
		? ["#05070d", "#172554", "#0f766e", "#831843"]
		: ["#f8fafc", "#bae6fd", "#ccfbf1", "#fbcfe8"];

	return (
		<View pointerEvents="none" style={styles.background}>
			<GrainyGradient
				amplitude={0.18}
				brightness={isDark ? -0.08 : 0.02}
				colors={gradientColors}
				intensity={isDark ? 0.085 : 0.052}
				size={2.2}
				speed={0.42}
				style={StyleSheet.absoluteFill}
			/>
			<BlurView
				intensity={isDark ? 12 : 18}
				style={StyleSheet.absoluteFill}
				tint={theme.mode === "dark" ? "dark" : "light"}
			/>
			<View style={styles.backgroundVignette} />
		</View>
	);
}

function createStyles(theme: HelmorTheme) {
	const isDark = theme.mode === "dark";

	return StyleSheet.create({
		root: {
			backgroundColor: theme.colors.bg,
			flex: 1,
		},
		background: {
			bottom: 0,
			left: 0,
			overflow: "hidden",
			position: "absolute",
			right: 0,
			top: 0,
		},
		backgroundVignette: {
			backgroundColor: isDark
				? "rgba(0, 0, 0, 0.28)"
				: "rgba(255, 255, 255, 0.10)",
			bottom: 0,
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
		},
		header: {
			alignItems: "center",
			flexDirection: "row",
			gap: 12,
			height: 56,
			justifyContent: "center",
			paddingHorizontal: 24,
		},
		brandLogo: {
			borderCurve: "continuous",
			borderRadius: 13,
			height: 44,
			width: 44,
		},
		brand: {
			color: theme.colors.text,
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: 30,
			fontWeight: "800",
			letterSpacing: 0,
		},
		stage: {
			alignItems: "center",
			flex: 1,
			justifyContent: "center",
			paddingBottom: HERO_INITIAL_BOTTOM_OFFSET,
			paddingHorizontal: 18,
		},
		stageCompact: {
			paddingBottom: HERO_INITIAL_BOTTOM_OFFSET_COMPACT,
		},
		hero: {
			backgroundColor: theme.colors.elevated,
			borderColor: isDark
				? "rgba(255, 255, 255, 0.13)"
				: "rgba(24, 24, 27, 0.10)",
			borderCurve: "continuous",
			borderRadius: 26,
			borderWidth: 1,
			boxShadow: isDark
				? "0 22px 46px rgba(0, 0, 0, 0.42)"
				: "0 22px 46px rgba(24, 24, 27, 0.15)",
			overflow: "hidden",
		},
		video: {
			flex: 1,
		},
		cta: {
			bottom: 28,
			left: 0,
			position: "absolute",
			right: 0,
		},
	});
}
