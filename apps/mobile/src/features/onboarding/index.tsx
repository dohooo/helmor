import { StatusBar } from "expo-status-bar";
import { useCallback, useRef, useState } from "react";
import {
	Animated,
	Image,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	type ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PrimaryButton } from "../../components/primary-button";
import { useThemedStyles } from "../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../theme";
import { saveOnboardingCompleted } from "./onboarding-store";

type MobileOnboardingProps = {
	onOpenScanner: () => void;
	onSkip: () => void;
};

type Slide = {
	title: string;
	body: string;
	label: string;
};

const ONBOARDING_IMAGE = require("../../../assets/onboarding/helmor-mobile-onboarding.png");
const HELMOR_ICON = require("../../../assets/icon.png");

const SLIDES: Slide[] = [
	{
		label: "Secure by design",
		title: "Helmor on your phone",
		body: "Pair with your Mac to follow workspaces and conversations on the go.",
	},
	{
		label: "Your Mac stays in charge",
		title: "Local agents, mobile view",
		body: "Agents keep running locally on your machine while your phone stays connected.",
	},
	{
		label: "Connect in seconds",
		title: "Scan your desktop code",
		body: "Open Settings > Mobile companion on your Mac, then scan the pairing code.",
	},
];

export function MobileOnboarding({
	onOpenScanner,
	onSkip,
}: MobileOnboardingProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const { height, width } = useWindowDimensions();
	const [activeIndex, setActiveIndex] = useState(0);
	const [carouselWidth, setCarouselWidth] = useState(0);
	const carouselRef = useRef<ScrollView>(null);
	const scrollX = useRef(new Animated.Value(0)).current;
	const isFinalSlide = activeIndex === SLIDES.length - 1;

	const completeThen = useCallback(async (next: () => void) => {
		try {
			await saveOnboardingCompleted();
		} finally {
			next();
		}
	}, []);

	const scrollToSlide = useCallback(
		(nextIndex: number) => {
			setActiveIndex(nextIndex);
			if (carouselWidth > 0) {
				carouselRef.current?.scrollTo({
					animated: true,
					x: nextIndex * carouselWidth,
					y: 0,
				});
			}
		},
		[carouselWidth],
	);

	const handleScrollEnd = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const width = event.nativeEvent.layoutMeasurement.width;
			if (width <= 0) return;
			const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
			setActiveIndex(Math.max(0, Math.min(SLIDES.length - 1, nextIndex)));
		},
		[],
	);

	const handlePrimary = useCallback(() => {
		if (!isFinalSlide) {
			scrollToSlide(activeIndex + 1);
			return;
		}
		void completeThen(onOpenScanner);
	}, [activeIndex, completeThen, isFinalSlide, onOpenScanner, scrollToSlide]);

	const copyMotionStyle = useCallback(
		(index: number) => {
			if (carouselWidth <= 0) return null;
			const center = index * carouselWidth;
			return {
				opacity: scrollX.interpolate({
					extrapolate: "clamp",
					inputRange: [center - carouselWidth, center, center + carouselWidth],
					outputRange: [0.58, 1, 0.58],
				}),
				transform: [
					{
						translateY: scrollX.interpolate({
							extrapolate: "clamp",
							inputRange: [
								center - carouselWidth,
								center,
								center + carouselWidth,
							],
							outputRange: [18, 0, 18],
						}),
					},
				],
			};
		},
		[carouselWidth, scrollX],
	);

	return (
		<View
			accessibilityLabel="Helmor mobile onboarding"
			onLayout={(event) => setCarouselWidth(event.nativeEvent.layout.width)}
			style={styles.container}
		>
			<Image
				accessibilityIgnoresInvertColors
				resizeMode="stretch"
				source={ONBOARDING_IMAGE}
				style={[styles.backgroundImage, { height, width }]}
			/>
			<StatusBar style="light" />
			<View pointerEvents="none" style={styles.scrim} />
			<View
				pointerEvents="box-none"
				style={[
					styles.header,
					{
						top: Math.max(insets.top, 16) + theme.spacing.md,
					},
				]}
			>
				<View pointerEvents="none" style={styles.brand}>
					<Image
						accessibilityIgnoresInvertColors
						source={HELMOR_ICON}
						style={styles.brandIcon}
					/>
					<Text style={styles.brandText}>Helmor</Text>
				</View>
				<Pressable
					accessibilityRole="button"
					hitSlop={10}
					onPress={() => void completeThen(onSkip)}
					style={styles.skip}
				>
					<Text style={styles.skipText}>Skip</Text>
				</Pressable>
			</View>

			<Animated.ScrollView
				ref={carouselRef}
				alwaysBounceHorizontal={false}
				decelerationRate="fast"
				horizontal
				onMomentumScrollEnd={handleScrollEnd}
				onScroll={Animated.event(
					[{ nativeEvent: { contentOffset: { x: scrollX } } }],
					{ useNativeDriver: true },
				)}
				pagingEnabled
				scrollEventThrottle={16}
				showsHorizontalScrollIndicator={false}
				style={styles.pager}
			>
				{SLIDES.map((slide, index) => (
					<View
						key={slide.title}
						style={[
							styles.slidePage,
							{
								paddingBottom: Math.max(insets.bottom, 16) + 158,
								paddingTop: Math.max(insets.top, 16) + 74,
								width: carouselWidth,
							},
						]}
					>
						<View style={styles.spacer} />

						<Animated.View style={[styles.slideCopy, copyMotionStyle(index)]}>
							<Text style={styles.label}>{slide.label}</Text>
							<Text style={styles.title}>{slide.title}</Text>
							<Text style={styles.body}>{slide.body}</Text>
						</Animated.View>
					</View>
				))}
			</Animated.ScrollView>

			<View
				pointerEvents="box-none"
				style={[
					styles.controls,
					{ paddingBottom: Math.max(insets.bottom, 16) + 10 },
				]}
			>
				<View style={styles.dots}>
					{SLIDES.map((slide, index) => (
						<View
							key={slide.title}
							style={[styles.dot, index === activeIndex && styles.activeDot]}
						/>
					))}
				</View>

				<View style={styles.footer}>
					<PrimaryButton
						label={isFinalSlide ? "Scan pairing code" : "Next"}
						onPress={handlePrimary}
					/>
				</View>
			</View>
		</View>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		container: {
			backgroundColor: "#111111",
			flex: 1,
		},
		backgroundImage: {
			bottom: 0,
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
		},
		scrim: {
			backgroundColor: "rgba(0, 0, 0, 0.10)",
			bottom: 0,
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
		},
		header: {
			alignItems: "center",
			flexDirection: "row",
			justifyContent: "space-between",
			left: theme.spacing.xl,
			position: "absolute",
			right: theme.spacing.xl,
			zIndex: 2,
		},
		skip: {
			marginRight: -theme.spacing.md,
			paddingHorizontal: theme.spacing.md,
			paddingVertical: theme.spacing.md,
		},
		skipText: {
			color: "rgba(255, 255, 255, 0.72)",
			fontFamily: "Avenir Next",
			fontSize: theme.text.body,
			fontWeight: "600",
			letterSpacing: 0,
		},
		pager: {
			flex: 1,
		},
		slidePage: {
			flex: 1,
			paddingHorizontal: theme.spacing.xl,
		},
		brand: {
			alignItems: "center",
			flexDirection: "row",
			gap: theme.spacing.sm,
		},
		brandIcon: {
			backgroundColor: "rgba(255, 255, 255, 0.94)",
			borderColor: "rgba(255, 255, 255, 0.28)",
			borderRadius: 11,
			borderWidth: StyleSheet.hairlineWidth,
			height: 34,
			width: 34,
		},
		brandText: {
			color: "#ffffff",
			fontFamily: "Avenir Next",
			fontSize: 22,
			fontWeight: "700",
			letterSpacing: 0,
		},
		spacer: {
			flex: 1,
		},
		slideCopy: {
			gap: theme.spacing.sm,
		},
		label: {
			color: "rgba(255, 255, 255, 0.62)",
			fontFamily: "Avenir Next",
			fontSize: theme.text.ui,
			fontWeight: "700",
			letterSpacing: 0.2,
			textTransform: "uppercase",
		},
		title: {
			color: "#ffffff",
			fontFamily: "Avenir Next",
			fontSize: 44,
			fontWeight: "500",
			letterSpacing: -0.7,
			lineHeight: 52,
		},
		body: {
			color: "rgba(255, 255, 255, 0.72)",
			fontFamily: "Avenir Next",
			fontSize: 17,
			fontWeight: "400",
			lineHeight: 24,
			maxWidth: 330,
		},
		dots: {
			alignItems: "center",
			flexDirection: "row",
			gap: 8,
			justifyContent: "center",
			marginBottom: theme.spacing.md,
		},
		dot: {
			backgroundColor: "rgba(255, 255, 255, 0.22)",
			borderRadius: 4,
			height: 8,
			width: 8,
		},
		activeDot: {
			backgroundColor: "#ffffff",
			width: 24,
		},
		footer: {
			gap: theme.spacing.md,
		},
		controls: {
			bottom: 0,
			left: 0,
			paddingHorizontal: theme.spacing.xl,
			position: "absolute",
			right: 0,
		},
	});
}
