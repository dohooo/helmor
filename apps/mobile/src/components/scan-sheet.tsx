import { BottomSheet, BottomSheetView } from "@expo/ui/community/bottom-sheet";
import {
	type BarcodeScanningResult,
	CameraView,
	useCameraPermissions,
} from "expo-camera";
import {
	GlassView,
	isGlassEffectAPIAvailable,
	isLiquidGlassAvailable,
} from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const { height } = useWindowDimensions();
	const [permission, requestPermission] = useCameraPermissions();
	const [locked, setLocked] = useState(false);
	const liquidGlassAvailable = useMemo(() => {
		try {
			return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
		} catch {
			return false;
		}
	}, []);

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
		<BottomSheet
			enablePanDownToClose
			index={visible ? 0 : -1}
			onClose={onClose}
			snapPoints={["full"]}
		>
			<BottomSheetView
				style={[
					styles.sheetContent,
					{
						height: Math.max(height - Math.max(insets.top, 16), 0),
						paddingBottom: Math.max(insets.bottom, 16),
					},
				]}
			>
				<GlassSurface enabled={liquidGlassAvailable}>
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
								<Text style={styles.permissionTitle}>Allow camera access</Text>
								<Text style={styles.permissionCopy}>
									The camera is only used to scan your Helmor pairing code.
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

						<Pressable
							accessibilityLabel="Close scanner"
							accessibilityRole="button"
							hitSlop={10}
							onPress={onClose}
							style={styles.closeButton}
						>
							<Text style={styles.close}>×</Text>
						</Pressable>

						<View pointerEvents="none" style={styles.statusPill}>
							<Text style={styles.statusTitle}>Scan pairing code</Text>
							<Text style={styles.statusText}>Looking for a Helmor QR</Text>
						</View>

						{busy ? (
							<View style={styles.busyOverlay}>
								<ActivityIndicator color="#ffffff" />
								<Text style={styles.busyText}>Connecting to your desktop…</Text>
							</View>
						) : null}
					</View>

					{error ? (
						<View style={styles.errorCard}>
							<Text selectable style={styles.error}>
								{error}
							</Text>
						</View>
					) : null}
				</GlassSurface>
			</BottomSheetView>
		</BottomSheet>
	);
}

function GlassSurface({
	children,
	enabled,
}: {
	children: ReactNode;
	enabled: boolean;
}) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	if (!enabled) {
		return <View style={styles.fallbackSurface}>{children}</View>;
	}

	return (
		<GlassView
			colorScheme={theme.mode}
			glassEffectStyle="regular"
			style={styles.glassSurface}
		>
			{children}
		</GlassView>
	);
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		sheetContent: {
			paddingHorizontal: 0,
		},
		glassSurface: {
			borderRadius: theme.radii.xl,
			flex: 1,
			overflow: "hidden",
		},
		fallbackSurface: {
			borderRadius: theme.radii.xl,
			flex: 1,
			overflow: "hidden",
		},
		closeButton: {
			alignItems: "center",
			backgroundColor: "rgba(0, 0, 0, 0.52)",
			borderColor: "rgba(255, 255, 255, 0.18)",
			borderRadius: 18,
			borderWidth: 1,
			height: 36,
			justifyContent: "center",
			position: "absolute",
			right: theme.spacing.md,
			top: theme.spacing.md,
			width: 36,
			zIndex: 2,
		},
		close: {
			color: "#ffffff",
			fontSize: 22,
			fontWeight: "700",
			letterSpacing: 0,
			lineHeight: 24,
		},
		cameraFrame: {
			backgroundColor: theme.colors.cameraBackground,
			flex: 1,
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
		statusPill: {
			alignSelf: "stretch",
			backgroundColor: "rgba(0, 0, 0, 0.56)",
			borderColor: "rgba(255, 255, 255, 0.18)",
			borderRadius: theme.radii.lg,
			borderWidth: 1,
			bottom: theme.spacing.lg,
			left: theme.spacing.md,
			paddingHorizontal: theme.spacing.md,
			paddingVertical: theme.spacing.sm,
			position: "absolute",
			right: theme.spacing.md,
		},
		statusTitle: {
			color: "#ffffff",
			fontSize: theme.text.body,
			fontWeight: "800",
			letterSpacing: 0,
			textAlign: "center",
		},
		statusText: {
			color: "rgba(255, 255, 255, 0.72)",
			fontSize: theme.text.ui,
			fontWeight: "700",
			letterSpacing: 0,
			marginTop: 2,
			textAlign: "center",
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
			color: "#ffffff",
			fontSize: theme.text.body,
			fontWeight: "700",
			letterSpacing: 0,
		},
		errorCard: {
			backgroundColor:
				theme.mode === "light"
					? "rgba(220, 38, 38, 0.08)"
					: "rgba(251, 113, 133, 0.12)",
			borderColor:
				theme.mode === "light"
					? "rgba(220, 38, 38, 0.22)"
					: "rgba(251, 113, 133, 0.24)",
			borderRadius: theme.radii.md,
			borderWidth: 1,
			bottom: theme.spacing.md,
			left: theme.spacing.md,
			padding: theme.spacing.sm,
			position: "absolute",
			right: theme.spacing.md,
		},
		error: {
			color: theme.colors.danger,
			fontSize: theme.text.ui,
			lineHeight: 18,
			textAlign: "center",
		},
	});
}
