import { BlurView } from "expo-blur";
import type React from "react";
import { memo, useEffect } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, {
	Easing,
	Extrapolation,
	interpolate,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withTiming,
} from "react-native-reanimated";
import type { AnimatedWordProps, FadeTextProps } from "./types";

export { ChromaRing } from "./reacticx/chroma-ring";
export { GrainyGradient } from "./reacticx/grainy-gradient";

export const FadeText: React.FC<FadeTextProps> = memo<FadeTextProps>(
	({
		inputs,
		initialDelay = 0,
		wordDelay = 300,
		duration = 800,
		blurIntensity = [30, 10, 0],
		blurTint = "dark",
		scaleRange = [0.97, 1],
		translateYRange = [10, 0],
		opacityRange = [0, 0.5, 1],
		fontSize = 32,
		fontWeight = "600",
		color = "#ffffff",
		textAlign = "center",
		containerStyle,
		style,
	}: FadeTextProps): React.ReactNode & React.JSX.Element => {
		const words = inputs.flatMap((text, inputIndex) =>
			text.split(" ").map((word) => ({ word, inputIndex })),
		);

		return (
			<View style={[styles.container, containerStyle]}>
				<View style={styles.textWrapper}>
					{words.map((item, index) => (
						<AnimatedWord
							key={index}
							word={item.word}
							index={index}
							delay={initialDelay + index * wordDelay}
							duration={duration}
							blurIntensity={blurIntensity}
							blurTint={blurTint}
							scaleRange={scaleRange}
							translateYRange={translateYRange}
							opacityRange={opacityRange}
							fontSize={fontSize}
							style={style}
							fontWeight={fontWeight}
							color={color}
							textAlign={textAlign}
						/>
					))}
				</View>
			</View>
		);
	},
);

const AnimatedWord: React.FC<AnimatedWordProps> = memo<AnimatedWordProps>(
	({
		word,
		delay,
		duration,
		blurIntensity,
		blurTint,
		scaleRange,
		translateYRange,
		opacityRange,
		fontSize,
		fontWeight,
		color,
		textAlign,
		style,
	}: AnimatedWordProps): React.ReactNode & React.JSX.Element => {
		const animationValue = useSharedValue<number>(0);

		useEffect(() => {
			animationValue.value = withDelay(
				delay,
				withTiming<number>(1, {
					duration,
					easing: Easing.out(Easing.cubic),
				}),
			);
		}, [animationValue, delay, duration]);

		const animatedStyle = useAnimatedStyle<
			Pick<ViewStyle, "opacity" | "transform">
		>(() => {
			const opacity = interpolate(
				animationValue.value,
				[0, 0.8, 1],
				opacityRange,
				Extrapolation.CLAMP,
			);

			const scale = interpolate(
				animationValue.value,
				[0, 1],
				scaleRange,
				Extrapolation.CLAMP,
			);

			const translateY = interpolate(
				animationValue.value,
				[0, 1],
				translateYRange,
				Extrapolation.CLAMP,
			);

			return {
				opacity,
				transform: [{ scale }, { translateY }],
			};
		});

		const blurOverlayStyle = useAnimatedStyle(() => {
			const opacity = interpolate(
				animationValue.value,
				[0, 0.3, 1],
				[1, 0.45, 0],
				Extrapolation.CLAMP,
			);

			return {
				opacity,
			};
		});

		return (
			<Animated.View style={[styles.wordContainer, animatedStyle]}>
				<Text
					style={[
						styles.word,
						{
							fontSize,
							fontWeight,
							color,
							textAlign,
						},
						style,
					]}
				>
					{word}{" "}
				</Text>
				<Animated.View style={[StyleSheet.absoluteFill, blurOverlayStyle]}>
					<BlurView
						intensity={blurIntensity[0]}
						style={StyleSheet.absoluteFill}
						tint={blurTint}
					/>
				</Animated.View>
			</Animated.View>
		);
	},
);

const styles = StyleSheet.create({
	container: {
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 20,
	},
	textWrapper: {
		alignItems: "center",
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "center",
	},
	wordContainer: {
		borderRadius: 4,
		overflow: "hidden",
	},
	word: {},
});
