import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../lib/use-themed-styles";
import type { HelmorTheme } from "../theme";
import { PrimaryButton } from "./primary-button";

type PairingHomeProps = {
	onOpenScanner: () => void;
	error: string | null;
};

export function PairingHome({ onOpenScanner, error }: PairingHomeProps) {
	const styles = useThemedStyles(createStyles);

	return (
		<View style={styles.container}>
			<View style={styles.header}>
				<View style={styles.mark}>
					<Text style={styles.markText}>H</Text>
				</View>
				<Text style={styles.title}>Connect to Helmor</Text>
				<Text style={styles.subtitle}>
					Scan the pairing code from Settings &gt; Mobile companion.
				</Text>
			</View>

			<View style={styles.panel}>
				<View style={styles.statusRow}>
					<View style={styles.statusDot} />
					<Text style={styles.statusText}>No device paired yet.</Text>
				</View>
				<Text style={styles.panelCopy}>
					Keep Helmor open on your Mac, then scan the QR code from this app.
				</Text>
			</View>

			{error ? (
				<Text selectable style={styles.error}>
					{error}
				</Text>
			) : null}

			<PrimaryButton label="Scan pairing code" onPress={onOpenScanner} />
		</View>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		container: {
			flex: 1,
			justifyContent: "center",
			paddingHorizontal: theme.spacing.xl,
		},
		header: {
			alignItems: "center",
			marginBottom: 30,
		},
		mark: {
			alignItems: "center",
			backgroundColor: theme.colors.elevated,
			borderColor: theme.colors.border,
			borderRadius: theme.radii.lg,
			borderWidth: 1,
			height: 50,
			justifyContent: "center",
			marginBottom: theme.spacing.lg,
			width: 50,
		},
		markText: {
			color: theme.colors.text,
			fontSize: 22,
			fontWeight: "800",
			letterSpacing: 0,
		},
		title: {
			color: theme.colors.text,
			fontSize: 27,
			fontWeight: "800",
			letterSpacing: 0,
			textAlign: "center",
		},
		subtitle: {
			color: theme.colors.textMuted,
			fontSize: theme.text.title,
			lineHeight: 22,
			marginTop: theme.spacing.sm,
			textAlign: "center",
		},
		panel: {
			backgroundColor: theme.colors.surface,
			borderColor: theme.colors.borderSubtle,
			borderRadius: theme.radii.lg,
			borderWidth: 1,
			marginBottom: theme.spacing.lg,
			padding: theme.spacing.lg,
		},
		statusRow: {
			alignItems: "center",
			flexDirection: "row",
			gap: 10,
			justifyContent: "center",
			marginBottom: theme.spacing.sm,
		},
		statusDot: {
			backgroundColor: theme.colors.textSubtle,
			borderRadius: 4,
			height: 8,
			width: 8,
		},
		statusText: {
			color: theme.colors.text,
			fontSize: theme.text.title,
			fontWeight: "700",
			letterSpacing: 0,
		},
		panelCopy: {
			color: theme.colors.textMuted,
			fontSize: theme.text.body,
			lineHeight: 20,
			textAlign: "center",
		},
		error: {
			color: theme.colors.danger,
			fontSize: theme.text.body,
			lineHeight: 20,
			marginBottom: theme.spacing.md,
			textAlign: "center",
		},
	});
}
