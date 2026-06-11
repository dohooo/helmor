import * as Linking from "expo-linking";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CompanionWebView } from "../components/companion-web-view";
import { ScanSheet } from "../components/scan-sheet";
import { ConnectionGuide } from "../features/connection-guide";
import { useMobileBootState } from "../hooks/use-mobile-boot-state";
import { usePairingController } from "../hooks/use-pairing-controller";
import type { NativePairing } from "../lib/pairing";
import { clearPairing } from "../lib/pairing-store";
import { useThemedStyles } from "../lib/use-themed-styles";
import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";
import { resolveMobileShellRoute } from "./mobile-shell-state";

export function MobileShell() {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const [scannerOpen, setScannerOpen] = useState(false);
	const { bootError, booting, pairing, setBootError, setPairing } =
		useMobileBootState();
	const handlePaired = useCallback(
		(nextPairing: NativePairing) => {
			setPairing(nextPairing);
			setScannerOpen(false);
		},
		[setPairing],
	);
	const {
		busy: pairingBusy,
		error: pairingError,
		resetError: resetPairingError,
		setError: setPairingError,
		submitManualLink,
		submitScan,
	} = usePairingController({
		onPaired: handlePaired,
	});

	const handleScan = useCallback(
		(raw: string) => submitScan(raw),
		[submitScan],
	);

	const handleManualPairing = useCallback(
		(raw: string) => submitManualLink(raw),
		[submitManualLink],
	);

	useEffect(() => {
		let alive = true;

		Linking.getInitialURL()
			.then((url) => {
				if (alive && url) void handleManualPairing(url);
			})
			.catch(() => {
				if (alive) setPairingError("Pairing link could not be opened.");
			});

		const subscription = Linking.addEventListener("url", ({ url }) => {
			void handleManualPairing(url);
		});

		return () => {
			alive = false;
			subscription.remove();
		};
	}, [handleManualPairing, setPairingError]);

	const handleForget = useCallback(() => {
		void clearPairing();
		setPairing(null);
		setBootError(null);
		resetPairingError();
		setScannerOpen(false);
	}, [resetPairingError, setBootError, setPairing]);

	const handleOpenScanner = useCallback(() => {
		resetPairingError();
		setScannerOpen(true);
	}, [resetPairingError]);

	const route = resolveMobileShellRoute({
		booting,
		pairing,
	});

	if (route === "booting") {
		return (
			<View
				style={[
					styles.boot,
					{ paddingTop: insets.top, paddingBottom: insets.bottom },
				]}
			>
				<ActivityIndicator color={theme.colors.text} />
			</View>
		);
	}

	if (route === "paired" && pairing) {
		return <CompanionWebView pairing={pairing} onForget={handleForget} />;
	}

	if (route === "connectionGuide") {
		return (
			<View style={styles.container}>
				<ConnectionGuide
					busy={pairingBusy}
					error={!scannerOpen ? (pairingError ?? bootError) : null}
					onOpenScanner={handleOpenScanner}
				/>
				<ScanSheet
					busy={pairingBusy}
					error={scannerOpen ? pairingError : null}
					onClose={() => setScannerOpen(false)}
					onScanned={handleScan}
					visible={scannerOpen}
				/>
			</View>
		);
	}

	return null;
}

function createStyles(theme: HelmorTheme) {
	return StyleSheet.create({
		boot: {
			alignItems: "center",
			backgroundColor: theme.colors.bg,
			flex: 1,
			justifyContent: "center",
		},
		container: {
			backgroundColor: theme.colors.bg,
			flex: 1,
		},
	});
}
