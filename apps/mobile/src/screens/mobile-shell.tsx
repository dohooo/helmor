import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CompanionWebView } from "../components/companion-web-view";
import { PairingHome } from "../components/pairing-home";
import { ScanSheet } from "../components/scan-sheet";
import type { NativePairing } from "../lib/pairing";
import { parsePairingUrl, validatePairing } from "../lib/pairing";
import { clearPairing, loadPairing, savePairing } from "../lib/pairing-store";
import { useThemedStyles } from "../lib/use-themed-styles";
import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";

export function MobileShell() {
	const theme = useHelmorTheme();
	const styles = useThemedStyles(createStyles);
	const insets = useSafeAreaInsets();
	const [booting, setBooting] = useState(true);
	const [scannerOpen, setScannerOpen] = useState(false);
	const [pairing, setPairing] = useState<NativePairing | null>(null);
	const [pairingBusy, setPairingBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;

		loadPairing()
			.then((saved) => {
				if (alive) setPairing(saved);
			})
			.catch(() => {
				if (alive) setError("Stored pairing could not be restored.");
			})
			.finally(() => {
				if (alive) setBooting(false);
			});

		return () => {
			alive = false;
		};
	}, []);

	const handleScan = useCallback(async (raw: string) => {
		setPairingBusy(true);
		setError(null);

		try {
			const parsed = parsePairingUrl(raw);
			if (!parsed) {
				throw new Error("This QR code is not a Helmor pairing code.");
			}

			await validatePairing(parsed);
			await savePairing(parsed);
			setPairing(parsed);
			setScannerOpen(false);
		} catch (scanError) {
			setError(
				scanError instanceof Error ? scanError.message : "Pairing failed.",
			);
		} finally {
			setPairingBusy(false);
		}
	}, []);

	const handleForget = useCallback(() => {
		void clearPairing();
		setPairing(null);
		setError(null);
		setScannerOpen(true);
	}, []);

	if (booting) {
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

	if (pairing) {
		return <CompanionWebView pairing={pairing} onForget={handleForget} />;
	}

	return (
		<View
			style={[
				styles.container,
				{
					paddingTop: insets.top,
					paddingBottom: Math.max(insets.bottom, 16),
				},
			]}
		>
			<PairingHome
				error={!scannerOpen ? error : null}
				onOpenScanner={() => {
					setError(null);
					setScannerOpen(true);
				}}
			/>
			<ScanSheet
				busy={pairingBusy}
				error={scannerOpen ? error : null}
				onClose={() => setScannerOpen(false)}
				onScanned={handleScan}
				visible={scannerOpen}
			/>
		</View>
	);
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
