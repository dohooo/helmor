import type { ReactNode } from "react";
import { useEffect } from "react";
import {
	ActivityIndicator,
	Pressable,
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

import { ChromaRing, FadeText } from "../../../components/ui";
import { useThemedStyles } from "../../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../../theme";
import { CONNECTION_GUIDE_DISPLAY_FONT } from "../typography";

type OnboardingCtaPanelProps = {
	busy: boolean;
	error: string | null;
	onScanPress: () => void;
	startDelay?: number;
};

type AnimatedCtaItemProps = {
	children: ReactNode;
	delay: number;
	style?: object;
};

const CTA_ITEM_DURATION = 920;
const CTA_TITLE_DELAY = 0;
const CTA_DESCRIPTION_DELAY = 520;
const CTA_BUTTON_DELAY = 1450;
const CTA_HINT_DELAY = 2150;
const CTA_ERROR_DELAY = 2850;

export function OnboardingCtaPanel({
	busy,
	error,
	onScanPress,
	startDelay = 0,
}: OnboardingCtaPanelProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const { width } = useWindowDimensions();
	const buttonWidth = Math.min(width - 48, 340);
	const isDark = theme.mode === "dark";

	return (
		<View style={styles.panel}>
			<FadeText
				inputs={["Connect your Helmor desktop"]}
				initialDelay={startDelay + CTA_TITLE_DELAY}
				wordDelay={82}
				duration={620}
				blurTint="prominent"
				containerStyle={[styles.copy, styles.fadeTextContainer]}
				style={styles.title}
			/>

			<FadeText
				inputs={[
					"Open Helmor on your Mac and scan the QR code to sync your workspace.",
				]}
				initialDelay={startDelay + CTA_DESCRIPTION_DELAY}
				wordDelay={42}
				duration={620}
				blurIntensity={[18, 7, 0]}
				blurTint="prominent"
				containerStyle={[styles.copy, styles.fadeTextContainer]}
				style={styles.description}
			/>

			<AnimatedCtaItem
				delay={startDelay + CTA_BUTTON_DELAY}
				style={styles.buttonItem}
			>
				<ChromaRing
					background={
						isDark ? "rgba(7, 10, 18, 0.86)" : "rgba(255, 255, 255, 0.84)"
					}
					base={isDark ? "#134e4a" : "#38bdf8"}
					borderRadius={19}
					borderWidth={2}
					glow={isDark ? "#f0abfc" : "#7c3aed"}
					height={58}
					speed={1.35}
					width={buttonWidth}
				>
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ disabled: busy }}
						disabled={busy}
						hitSlop={8}
						onPress={onScanPress}
						style={({ pressed }) => [
							styles.scanButton,
							pressed && !busy && styles.scanButtonPressed,
							busy && styles.scanButtonDisabled,
						]}
					>
						{busy ? (
							<ActivityIndicator color={styles.scanButtonText.color} />
						) : null}
						{!busy ? <ScanIcon /> : null}
						<Text style={styles.scanButtonText}>Scan to Connect</Text>
					</Pressable>
				</ChromaRing>
			</AnimatedCtaItem>

			<FadeText
				inputs={["Keep Helmor running on your desktop"]}
				initialDelay={startDelay + CTA_HINT_DELAY}
				wordDelay={48}
				duration={560}
				blurIntensity={[14, 5, 0]}
				blurTint="prominent"
				containerStyle={styles.fadeTextContainer}
				style={styles.hint}
			/>

			{error ? (
				<AnimatedCtaItem
					delay={startDelay + CTA_ERROR_DELAY}
					style={styles.errorItem}
				>
					<View style={styles.errorBanner}>
						<Text selectable style={styles.errorText}>
							{error}
						</Text>
					</View>
				</AnimatedCtaItem>
			) : null}
		</View>
	);
}

function AnimatedCtaItem({ children, delay, style }: AnimatedCtaItemProps) {
	const styles = useThemedStyles(createStyles);
	const progress = useSharedValue(0);

	useEffect(() => {
		progress.value = withDelay(
			delay,
			withTiming(1, {
				duration: CTA_ITEM_DURATION,
				easing: Easing.bezier(0.16, 1, 0.3, 1),
			}),
		);
	}, [delay, progress]);

	const itemStyle = useAnimatedStyle(() => ({
		opacity: progress.value,
		transform: [{ translateY: 16 * (1 - progress.value) }],
	}));

	return (
		<Animated.View style={[styles.animatedItem, style, itemStyle]}>
			{children}
		</Animated.View>
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
		panel: {
			alignItems: "center",
			gap: 12,
			paddingHorizontal: 24,
			width: "100%",
		},
		animatedItem: {
			alignItems: "center",
			opacity: 0,
			position: "relative",
			width: "100%",
		},
		copy: {
			alignItems: "center",
			maxWidth: 340,
		},
		fadeTextContainer: {
			paddingHorizontal: 0,
		},
		buttonItem: {
			alignItems: "center",
			maxWidth: 340,
		},
		errorItem: {
			maxWidth: 340,
		},
		title: {
			color: theme.colors.text,
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: 24,
			fontWeight: "800",
			letterSpacing: 0,
			lineHeight: 30,
			textAlign: "center",
		},
		description: {
			color: theme.colors.textMuted,
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: 15,
			fontWeight: "500",
			letterSpacing: 0,
			lineHeight: 22,
			textAlign: "center",
		},
		scanButton: {
			alignItems: "center",
			borderCurve: "continuous",
			borderRadius: 17,
			flexDirection: "row",
			gap: 10,
			height: "100%",
			justifyContent: "center",
			width: "100%",
		},
		scanButtonPressed: {
			opacity: 0.78,
		},
		scanButtonDisabled: {
			opacity: 0.56,
		},
		scanButtonText: {
			color: isDark ? "#f8fafc" : "#0f172a",
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: 16,
			fontWeight: "800",
			letterSpacing: 0,
		},
		hint: {
			color: theme.colors.textSubtle,
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: theme.text.ui,
			fontWeight: "600",
			letterSpacing: 0,
			lineHeight: 18,
			textAlign: "center",
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
			paddingHorizontal: 14,
			paddingVertical: 10,
			width: "100%",
		},
		errorText: {
			color: theme.colors.danger,
			fontFamily: CONNECTION_GUIDE_DISPLAY_FONT,
			fontSize: theme.text.body,
			fontWeight: "600",
			letterSpacing: 0,
			lineHeight: 20,
			textAlign: "center",
		},
		scanIcon: {
			height: 18,
			position: "relative",
			width: 18,
		},
		scanCorner: {
			borderColor: isDark ? "#f8fafc" : "#0f172a",
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
	});
}
