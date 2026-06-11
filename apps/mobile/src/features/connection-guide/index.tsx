import {
	Image,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PrimaryButton } from "../../components/primary-button";
import { useThemedStyles } from "../../lib/use-themed-styles";
import { type HelmorTheme, useHelmorTheme } from "../../theme";

type ConnectionGuideProps = {
	busy: boolean;
	error: string | null;
	onOpenScanner: () => void;
	onReviewIntro: () => void;
};

const HELMOR_ICON = require("../../../assets/icon.png");

const STEPS = [
	{
		title: "Open Settings > Mobile companion",
		body: "Keep Helmor running on your computer and open the Mobile companion panel.",
	},
	{
		title: "Choose LAN or Cloudflare tunnel",
		body: "Turn on Mobile access for same-network pairing, or enable Cloudflare tunnel for remote access.",
	},
	{
		title: "Scan the QR code",
		body: "Use this phone to scan the current code and finish connecting.",
	},
];

export function ConnectionGuide({
	busy,
	error,
	onOpenScanner,
	onReviewIntro,
}: ConnectionGuideProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();

	return (
		<ScrollView
			contentContainerStyle={[
				styles.content,
				{
					paddingTop: Math.max(insets.top, 16) + theme.spacing.lg,
					paddingBottom: Math.max(insets.bottom, 16) + theme.spacing.xl,
				},
			]}
			contentInsetAdjustmentBehavior="automatic"
			keyboardShouldPersistTaps="handled"
			style={styles.container}
		>
			<View style={styles.header}>
				<Image
					accessibilityIgnoresInvertColors
					source={HELMOR_ICON}
					style={styles.icon}
				/>
				<View style={styles.headerCopy}>
					<Text style={styles.eyebrow}>Connection guide</Text>
					<Text style={styles.title}>Connect to Helmor</Text>
				</View>
			</View>

			<Text style={styles.intro}>
				Use the QR code from Helmor on your computer. Pair nearby over LAN, or
				remotely through Cloudflare tunnel.
			</Text>

			{error ? (
				<View style={styles.errorBanner}>
					<Text selectable style={styles.errorText}>
						{error}
					</Text>
				</View>
			) : null}

			<View style={styles.steps}>
				{STEPS.map((step, index) => (
					<View key={step.title} style={styles.step}>
						<View style={styles.stepNumber}>
							<Text style={styles.stepNumberText}>{index + 1}</Text>
						</View>
						<View style={styles.stepCopy}>
							<Text style={styles.stepTitle}>{step.title}</Text>
							<Text style={styles.stepBody}>{step.body}</Text>
						</View>
					</View>
				))}
			</View>

			<View style={styles.actions}>
				<PrimaryButton
					label="Scan QR code"
					loading={busy}
					onPress={onOpenScanner}
				/>
			</View>

			<Pressable
				accessibilityRole="button"
				hitSlop={10}
				onPress={onReviewIntro}
				style={styles.reviewIntro}
			>
				<Text style={styles.reviewIntroText}>What can Helmor Mobile do?</Text>
			</Pressable>
		</ScrollView>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		container: {
			backgroundColor: theme.colors.bg,
			flex: 1,
		},
		content: {
			gap: theme.spacing.md,
			paddingHorizontal: theme.spacing.lg,
		},
		header: {
			alignItems: "center",
			flexDirection: "row",
			gap: theme.spacing.md,
		},
		icon: {
			backgroundColor: theme.colors.elevated,
			borderColor: theme.colors.border,
			borderRadius: theme.radii.md,
			borderWidth: 1,
			height: 50,
			width: 50,
		},
		headerCopy: {
			flex: 1,
			gap: 3,
		},
		eyebrow: {
			color: theme.colors.textMuted,
			fontSize: theme.text.ui,
			fontWeight: "800",
			letterSpacing: 0,
			textTransform: "uppercase",
		},
		title: {
			color: theme.colors.text,
			fontSize: 30,
			fontWeight: "800",
			letterSpacing: 0,
			lineHeight: 34,
		},
		intro: {
			color: theme.colors.textMuted,
			fontSize: theme.text.title,
			lineHeight: 21,
		},
		errorBanner: {
			backgroundColor:
				theme.mode === "light"
					? "rgba(220, 38, 38, 0.08)"
					: "rgba(251, 113, 133, 0.12)",
			borderColor:
				theme.mode === "light"
					? "rgba(220, 38, 38, 0.20)"
					: "rgba(251, 113, 133, 0.24)",
			borderRadius: theme.radii.md,
			borderWidth: 1,
			padding: theme.spacing.md,
		},
		errorText: {
			color: theme.colors.danger,
			fontSize: theme.text.body,
			lineHeight: 20,
		},
		steps: {
			gap: theme.spacing.sm,
		},
		step: {
			alignItems: "flex-start",
			flexDirection: "row",
			gap: theme.spacing.md,
		},
		stepNumber: {
			alignItems: "center",
			backgroundColor: theme.colors.elevated,
			borderColor: theme.colors.border,
			borderRadius: 14,
			borderWidth: 1,
			height: 28,
			justifyContent: "center",
			width: 28,
		},
		stepNumberText: {
			color: theme.colors.text,
			fontSize: theme.text.ui,
			fontVariant: ["tabular-nums"],
			fontWeight: "800",
			letterSpacing: 0,
		},
		stepCopy: {
			flex: 1,
			gap: 4,
			paddingTop: 2,
		},
		stepTitle: {
			color: theme.colors.text,
			fontSize: theme.text.title,
			fontWeight: "800",
			letterSpacing: 0,
		},
		stepBody: {
			color: theme.colors.textMuted,
			fontSize: theme.text.ui,
			lineHeight: 18,
		},
		actions: {
			gap: theme.spacing.lg,
		},
		reviewIntro: {
			alignItems: "center",
			paddingVertical: theme.spacing.sm,
		},
		reviewIntroText: {
			color: theme.colors.textMuted,
			fontSize: theme.text.body,
			fontWeight: "700",
			letterSpacing: 0,
		},
	});
}
