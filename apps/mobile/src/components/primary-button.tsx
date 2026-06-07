import type { ReactNode } from "react";
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";

import { useThemedStyles } from "../lib/use-themed-styles";
import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";

type ButtonTone = "primary" | "secondary" | "danger";

type PrimaryButtonProps = {
	label: string;
	onPress: () => void;
	tone?: ButtonTone;
	disabled?: boolean;
	loading?: boolean;
	icon?: ReactNode;
};

export function PrimaryButton({
	label,
	onPress,
	tone = "primary",
	disabled,
	loading,
	icon,
}: PrimaryButtonProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled: disabled || loading }}
			disabled={disabled || loading}
			hitSlop={8}
			onPress={onPress}
			style={({ pressed }) => [
				styles.button,
				styles[tone],
				(disabled || loading) && styles.disabled,
				pressed && !disabled && !loading && styles.pressed,
			]}
		>
			{loading ? (
				<ActivityIndicator
					color={
						tone === "primary" ? theme.colors.accentText : theme.colors.text
					}
				/>
			) : null}
			{!loading && icon ? <View style={styles.icon}>{icon}</View> : null}
			<Text
				style={[
					styles.label,
					tone === "primary" && styles.primaryLabel,
					tone === "danger" && styles.dangerLabel,
				]}
			>
				{label}
			</Text>
		</Pressable>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		button: {
			alignItems: "center",
			borderRadius: theme.radii.md,
			borderWidth: 1,
			flexDirection: "row",
			gap: 8,
			justifyContent: "center",
			minHeight: 46,
			paddingHorizontal: 16,
		},
		primary: {
			backgroundColor: theme.colors.accent,
			borderColor: theme.colors.accent,
		},
		secondary: {
			backgroundColor: theme.colors.accentMuted,
			borderColor: theme.colors.border,
		},
		danger: {
			backgroundColor: "transparent",
			borderColor: theme.colors.danger,
		},
		disabled: {
			opacity: 0.52,
		},
		pressed: {
			transform: [{ scale: 0.985 }],
		},
		icon: {
			alignItems: "center",
			justifyContent: "center",
		},
		label: {
			color: theme.colors.accentMutedText,
			fontSize: theme.text.title,
			fontWeight: "700",
			letterSpacing: 0,
		},
		primaryLabel: {
			color: theme.colors.accentText,
		},
		dangerLabel: {
			color: theme.colors.danger,
		},
	});
}
