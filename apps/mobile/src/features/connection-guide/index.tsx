import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, {
	Easing,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useThemedStyles } from "../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../theme";
import { OnboardingCtaPanel } from "./components/onboarding-cta-panel";

type ConnectionGuideProps = {
	busy: boolean;
	error: string | null;
	onOpenScanner: () => void;
};

const GUIDE_VIDEO = require("../../../assets/connection-guide/desktop-pairing-guide.mp4");
const INTRO_HERO_MOVE_DELAY = 800;
const CTA_SHOW_DELAY = 1200;

const HERO_WIDTH_RATIO = 0.96;
const HERO_MAX_WIDTH = 460;
const HERO_ASPECT_RATIO = 4 / 3;
const HERO_MAX_HEIGHT_RATIO = 0.34;
const HERO_FINAL_SCALE = 0.95;
const HERO_MOVE_DISTANCE_RATIO = 0.085;
const HERO_MOVE_DURATION = 760;
const CTA_ITEM_SEQUENCE_DELAY = CTA_SHOW_DELAY + 80;
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
			INTRO_HERO_MOVE_DELAY,
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
	const glowProgress = useSharedValue(0);
	const isDark = theme.mode === "dark";
	const baseColors: [string, string, string] = isDark
		? ["#0f0f0f", "#111116", "#0f0f0f"]
		: ["#ffffff", "#f8fafc", "#ffffff"];
	const primaryColors: [string, string, string] = isDark
		? ["transparent", "rgba(94, 234, 212, 0.20)", "transparent"]
		: ["transparent", "rgba(14, 165, 233, 0.12)", "transparent"];
	const secondaryColors: [string, string, string] = isDark
		? ["transparent", "rgba(129, 140, 248, 0.18)", "transparent"]
		: ["transparent", "rgba(168, 85, 247, 0.10)", "transparent"];
	const tertiaryColors: [string, string, string] = isDark
		? ["transparent", "rgba(244, 114, 182, 0.10)", "transparent"]
		: ["transparent", "rgba(45, 212, 191, 0.08)", "transparent"];

	useEffect(() => {
		glowProgress.value = withRepeat(
			withTiming(1, {
				duration: 9200,
				easing: Easing.inOut(Easing.cubic),
			}),
			-1,
			true,
		);
	}, [glowProgress]);

	const primaryGlowStyle = useAnimatedStyle(() => ({
		opacity: 0.44 + glowProgress.value * 0.16,
		transform: [
			{ translateX: -34 + glowProgress.value * 58 },
			{ translateY: -16 + glowProgress.value * 28 },
			{ rotate: "-13deg" },
			{ scale: 1.03 + glowProgress.value * 0.05 },
		],
	}));

	const secondaryGlowStyle = useAnimatedStyle(() => ({
		opacity: 0.34 + (1 - glowProgress.value) * 0.16,
		transform: [
			{ translateX: 38 - glowProgress.value * 64 },
			{ translateY: 22 - glowProgress.value * 38 },
			{ rotate: "11deg" },
			{ scale: 1.08 - glowProgress.value * 0.04 },
		],
	}));

	const tertiaryGlowStyle = useAnimatedStyle(() => ({
		opacity: 0.18 + glowProgress.value * 0.1,
		transform: [
			{ translateX: -18 + glowProgress.value * 34 },
			{ translateY: 18 - glowProgress.value * 26 },
			{ rotate: "-6deg" },
			{ scale: 1.02 + glowProgress.value * 0.03 },
		],
	}));

	return (
		<View pointerEvents="none" style={styles.background}>
			<LinearGradient colors={baseColors} style={StyleSheet.absoluteFill} />
			<Animated.View style={[styles.auroraLayerPrimary, primaryGlowStyle]}>
				<LinearGradient
					colors={primaryColors}
					end={{ x: 1, y: 0.5 }}
					start={{ x: 0, y: 0.5 }}
					style={styles.auroraGradient}
				/>
			</Animated.View>
			<Animated.View style={[styles.auroraLayerSecondary, secondaryGlowStyle]}>
				<LinearGradient
					colors={secondaryColors}
					end={{ x: 1, y: 0.5 }}
					start={{ x: 0, y: 0.5 }}
					style={styles.auroraGradient}
				/>
			</Animated.View>
			<Animated.View style={[styles.auroraLayerTertiary, tertiaryGlowStyle]}>
				<LinearGradient
					colors={tertiaryColors}
					end={{ x: 1, y: 0.5 }}
					start={{ x: 0, y: 0.5 }}
					style={styles.auroraGradient}
				/>
			</Animated.View>
			<BlurView
				intensity={42}
				style={StyleSheet.absoluteFill}
				tint={theme.mode === "dark" ? "dark" : "light"}
			/>
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
		auroraLayerPrimary: {
			height: 180,
			left: "-30%",
			position: "absolute",
			top: "12%",
			width: "160%",
		},
		auroraLayerSecondary: {
			height: 220,
			left: "-28%",
			position: "absolute",
			top: "36%",
			width: "156%",
		},
		auroraLayerTertiary: {
			bottom: "12%",
			height: 170,
			left: "-32%",
			position: "absolute",
			width: "164%",
		},
		auroraGradient: {
			borderRadius: 90,
			flex: 1,
		},
		header: {
			alignItems: "center",
			height: 32,
			justifyContent: "center",
			paddingHorizontal: 24,
		},
		brand: {
			color: theme.colors.text,
			fontSize: 17,
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
