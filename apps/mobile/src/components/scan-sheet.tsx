import {
	type BarcodeScanningResult,
	CameraView,
	useCameraPermissions,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";

import { useThemedStyles } from "../lib/use-themed-styles";
import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";
import { PrimaryButton } from "./primary-button";

type ScanSheetProps = {
	visible: boolean;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onScanned: (value: string) => void;
};

export function ScanSheet({
	visible,
	busy,
	error,
	onClose,
	onScanned,
}: ScanSheetProps) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const [permission, requestPermission] = useCameraPermissions();
	const [locked, setLocked] = useState(false);

	useEffect(() => {
		if (visible) setLocked(false);
	}, [visible]);

	useEffect(() => {
		if (visible && error) setLocked(false);
	}, [error, visible]);

	const handleBarcodeScanned = (result: BarcodeScanningResult) => {
		if (locked || busy) return;
		setLocked(true);
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		onScanned(result.data);
	};

	return (
		<Modal
			animationType="fade"
			transparent
			visible={visible}
			onRequestClose={onClose}
		>
			<View style={styles.backdrop}>
				<Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
				<View style={styles.sheet}>
					<View style={styles.sheetHeader}>
						<View>
							<Text style={styles.title}>Scan pairing code</Text>
							<Text style={styles.subtitle}>
								Point at the QR code in Helmor Settings.
							</Text>
						</View>
						<Pressable
							accessibilityRole="button"
							hitSlop={10}
							onPress={onClose}
						>
							<Text style={styles.close}>Close</Text>
						</Pressable>
					</View>

					<View style={styles.cameraFrame}>
						{permission?.granted ? (
							<CameraView
								active={visible}
								barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
								facing="back"
								onBarcodeScanned={
									busy || locked ? undefined : handleBarcodeScanned
								}
								style={StyleSheet.absoluteFill}
							/>
						) : (
							<View style={styles.permission}>
								<Text style={styles.permissionTitle}>Camera access needed</Text>
								<Text style={styles.permissionCopy}>
									Helmor uses the camera only to scan pairing QR codes.
								</Text>
								<PrimaryButton
									label="Allow camera"
									onPress={() => {
										void requestPermission();
									}}
									tone="secondary"
								/>
							</View>
						)}

						<View pointerEvents="none" style={styles.scanWindow}>
							<View style={[styles.corner, styles.cornerTopLeft]} />
							<View style={[styles.corner, styles.cornerTopRight]} />
							<View style={[styles.corner, styles.cornerBottomLeft]} />
							<View style={[styles.corner, styles.cornerBottomRight]} />
						</View>

						{busy ? (
							<View style={styles.busyOverlay}>
								<ActivityIndicator color={theme.colors.text} />
								<Text style={styles.busyText}>Pairing...</Text>
							</View>
						) : null}
					</View>

					{error ? (
						<Text selectable style={styles.error}>
							{error}
						</Text>
					) : null}
				</View>
			</View>
		</Modal>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		backdrop: {
			backgroundColor: theme.colors.backdrop,
			flex: 1,
			justifyContent: "center",
			paddingHorizontal: theme.spacing.lg,
		},
		sheet: {
			backgroundColor: theme.colors.overlaySurface,
			borderColor: theme.colors.border,
			borderRadius: theme.radii.xl,
			borderWidth: 1,
			overflow: "hidden",
			padding: theme.spacing.md,
		},
		sheetHeader: {
			alignItems: "flex-start",
			flexDirection: "row",
			justifyContent: "space-between",
			marginBottom: theme.spacing.md,
			paddingHorizontal: 2,
		},
		title: {
			color: theme.colors.text,
			fontSize: theme.text.heading,
			fontWeight: "800",
			letterSpacing: 0,
		},
		subtitle: {
			color: theme.colors.textMuted,
			fontSize: theme.text.ui,
			lineHeight: 18,
			marginTop: 4,
			maxWidth: 230,
		},
		close: {
			color: theme.colors.textMuted,
			fontSize: theme.text.body,
			fontWeight: "700",
			letterSpacing: 0,
			paddingTop: 2,
		},
		cameraFrame: {
			aspectRatio: 1,
			backgroundColor: theme.colors.cameraBackground,
			borderRadius: theme.radii.lg,
			overflow: "hidden",
		},
		permission: {
			alignItems: "center",
			flex: 1,
			justifyContent: "center",
			padding: theme.spacing.xl,
		},
		permissionTitle: {
			color: theme.colors.text,
			fontSize: 16,
			fontWeight: "800",
			letterSpacing: 0,
			marginBottom: theme.spacing.sm,
			textAlign: "center",
		},
		permissionCopy: {
			color: theme.colors.textMuted,
			fontSize: theme.text.body,
			lineHeight: 20,
			marginBottom: theme.spacing.lg,
			textAlign: "center",
		},
		scanWindow: {
			borderColor: "rgba(255, 255, 255, 0.18)",
			borderRadius: theme.radii.lg,
			borderWidth: 1,
			bottom: 38,
			left: 38,
			position: "absolute",
			right: 38,
			top: 38,
		},
		corner: {
			borderColor: theme.colors.text,
			height: 24,
			position: "absolute",
			width: 24,
		},
		cornerTopLeft: {
			borderLeftWidth: 3,
			borderTopWidth: 3,
			left: -1,
			top: -1,
		},
		cornerTopRight: {
			borderRightWidth: 3,
			borderTopWidth: 3,
			right: -1,
			top: -1,
		},
		cornerBottomLeft: {
			borderBottomWidth: 3,
			borderLeftWidth: 3,
			bottom: -1,
			left: -1,
		},
		cornerBottomRight: {
			borderBottomWidth: 3,
			borderRightWidth: 3,
			bottom: -1,
			right: -1,
		},
		busyOverlay: {
			alignItems: "center",
			backgroundColor: "rgba(0, 0, 0, 0.58)",
			bottom: 0,
			gap: theme.spacing.sm,
			justifyContent: "center",
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
		},
		busyText: {
			color: theme.colors.text,
			fontSize: theme.text.body,
			fontWeight: "700",
			letterSpacing: 0,
		},
		error: {
			color: theme.colors.danger,
			fontSize: theme.text.ui,
			lineHeight: 18,
			marginTop: theme.spacing.md,
			textAlign: "center",
		},
	});
}
