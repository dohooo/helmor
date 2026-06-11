import { BottomSheet, BottomSheetView } from "@expo/ui/community/bottom-sheet";
import {
	type BarcodeScanningResult,
	CameraView,
	useCameraPermissions,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	ActivityIndicator,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	View,
	type ViewStyle,
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
	const styles = useThemedStyles(createStyles);
	const [permission, requestPermission] = useCameraPermissions();
	const [locked, setLocked] = useState(false);
	const GlassViewComponent = useMemo(resolveGlassViewComponent, []);

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
			backgroundStyle={styles.transparentSheetBackground}
			enablePanDownToClose
			handleComponent={null}
			index={visible ? 0 : -1}
			onClose={onClose}
			snapPoints={["50%"]}
		>
			<BottomSheetView style={styles.sheetContent}>
				<GlassSurface GlassViewComponent={GlassViewComponent}>
					<View style={styles.cameraFrame}>
						{permission?.granted ? (
							<CameraView
								active={visible}
								barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
								facing="back"
								onBarcodeScanned={
									busy || locked ? undefined : handleBarcodeScanned
								}
								style={styles.cameraPreview}
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

						<View
							pointerEvents="none"
							style={[styles.statusPanel, error && styles.errorPanel]}
						>
							<Text style={[styles.statusTitle, error && styles.errorTitle]}>
								{error ? "Scan failed" : "Scan pairing code"}
							</Text>
							<Text
								numberOfLines={error ? 3 : 1}
								style={[styles.statusText, error && styles.errorMessage]}
							>
								{error ?? "Looking for a Helmor QR"}
							</Text>
						</View>

						{busy ? (
							<View style={styles.busyOverlay}>
								<ActivityIndicator color="#ffffff" />
								<Text style={styles.busyText}>Connecting to your desktop…</Text>
							</View>
						) : null}
					</View>
				</GlassSurface>
			</BottomSheetView>
		</BottomSheet>
	);
}

function GlassSurface({
	children,
	GlassViewComponent,
}: {
	children: ReactNode;
	GlassViewComponent: GlassViewComponent | null;
}) {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	if (!GlassViewComponent) {
		return <View style={styles.fallbackSurface}>{children}</View>;
	}

	return (
		<GlassViewComponent
			colorScheme={theme.mode}
			glassEffectStyle="regular"
			style={styles.glassSurface}
		>
			{children}
		</GlassViewComponent>
	);
}

type GlassViewComponent = ComponentType<{
	children?: ReactNode;
	colorScheme?: "light" | "dark";
	glassEffectStyle?: "regular" | "clear";
	style?: StyleProp<ViewStyle>;
}>;

type GlassEffectModule = {
	GlassView?: GlassViewComponent;
	isGlassEffectAPIAvailable?: () => boolean;
	isLiquidGlassAvailable?: () => boolean;
};

function resolveGlassViewComponent(): GlassViewComponent | null {
	try {
		const glassEffect = require("expo-glass-effect") as GlassEffectModule;
		if (
			!glassEffect.GlassView ||
			!glassEffect.isGlassEffectAPIAvailable?.() ||
			!glassEffect.isLiquidGlassAvailable?.()
		) {
			return null;
		}
		return glassEffect.GlassView;
	} catch {
		return null;
	}
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		sheetContent: {
			flex: 1,
			paddingHorizontal: 0,
		},
		transparentSheetBackground: {
			backgroundColor: "transparent",
		},
		glassSurface: {
			flex: 1,
			overflow: "visible",
		},
		fallbackSurface: {
			flex: 1,
			overflow: "visible",
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
			overflow: "visible",
		},
		cameraPreview: {
			bottom: -64,
			left: 0,
			position: "absolute",
			right: 0,
			top: 0,
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
		statusPanel: {
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
		errorPanel: {
			backgroundColor:
				theme.mode === "light"
					? "rgba(28, 12, 14, 0.78)"
					: "rgba(28, 12, 14, 0.82)",
			borderColor: "rgba(251, 113, 133, 0.42)",
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
		errorTitle: {
			color: "#fecdd3",
		},
		errorMessage: {
			color: "#fda4af",
			lineHeight: 18,
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
	});
}
