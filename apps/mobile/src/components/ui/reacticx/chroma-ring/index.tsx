import {
	Canvas,
	Fill,
	Shader,
	Skia,
	type Uniforms,
} from "@shopify/react-native-skia";
import type React from "react";
import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import {
	Easing,
	useDerivedValue,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { SHADER_SOURCE } from "./conf";
import { hexToRgb } from "./helper";
import type { IChromaRing } from "./types";

const LIQUID_METAL_BORDER_SHADER = Skia.RuntimeEffect.Make(SHADER_SOURCE)!;

export const ChromaRing: React.FC<IChromaRing> = memo<IChromaRing>(
	({
		width = 300,
		height = 56,
		borderRadius: customBorderRadius,
		borderWidth = 2,
		speed = 1.0,
		base = "#333340",
		glow = "#c0c8e0",
		background = "#0a0a0a",
		children,
		style,
	}) => {
		const borderRadius = customBorderRadius ?? height / 2;

		const baseColorRgb = hexToRgb<typeof base>(base);
		const glowColorRgb = hexToRgb<typeof glow>(glow);

		const time = useSharedValue<number>(0);

		useEffect(() => {
			time.value = withRepeat(
				withTiming(Math.PI * 200, {
					duration: 200000,
					easing: Easing.linear,
				}),
				-1,
				false,
			);
		}, [time]);

		const uniforms = useDerivedValue<Uniforms>(() => ({
			iResolution: [width, height],
			iTime: time.value,
			borderWidth,
			borderRadius,
			speed,
			baseColor: baseColorRgb,
			glowColor: glowColorRgb,
		}));

		return (
			<View style={[styles.container, { width, height, borderRadius }, style]}>
				<Canvas style={[StyleSheet.absoluteFill, { borderRadius }]}>
					<Fill>
						<Shader source={LIQUID_METAL_BORDER_SHADER} uniforms={uniforms} />
					</Fill>
				</Canvas>

				<View
					style={[
						styles.innerBackground,
						{
							backgroundColor: background,
							borderRadius: Math.max(0, borderRadius - borderWidth),
							margin: borderWidth,
						},
					]}
				/>

				<View style={[styles.contentContainer, { borderRadius }]}>
					{children}
				</View>
			</View>
		);
	},
);

const styles = StyleSheet.create({
	container: {
		overflow: "hidden",
		position: "relative",
	},
	innerBackground: {
		bottom: 0,
		left: 0,
		position: "absolute",
		right: 0,
		top: 0,
	},
	contentContainer: {
		alignItems: "center",
		bottom: 0,
		justifyContent: "center",
		left: 0,
		overflow: "hidden",
		position: "absolute",
		right: 0,
		top: 0,
	},
});

export default memo<IChromaRing>(ChromaRing);
