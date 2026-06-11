import * as Linking from "expo-linking";
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

const LOG_PREFIX = "[helmor-mobile:pairing]";

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
				logPairing("stored-pairing-loaded", {
					hasPairing: !!saved,
					baseUrl: saved?.baseUrl ?? null,
					token: saved ? tokenSummary(saved.token) : null,
				});
				if (!saved) return;
				return validatePairing(saved, 5_000)
					.then(() => {
						logPairing("stored-pairing-validated", {
							baseUrl: saved.baseUrl,
						});
						if (alive) setPairing(saved);
					})
					.catch((validationError) => {
						logPairing(
							"stored-pairing-validation-failed",
							{
								baseUrl: saved.baseUrl,
								message:
									validationError instanceof Error
										? validationError.message
										: String(validationError),
							},
							"warn",
						);
						void clearPairing();
						if (alive) {
							setError(
								"Saved Helmor link is no longer reachable. Paste a fresh pairing link from the desktop app.",
							);
						}
					});
			})
			.catch((loadError) => {
				logPairing(
					"stored-pairing-load-failed",
					{
						message:
							loadError instanceof Error
								? loadError.message
								: String(loadError),
					},
					"warn",
				);
				if (alive) setError("Stored pairing could not be restored.");
			})
			.finally(() => {
				if (alive) setBooting(false);
			});

		return () => {
			alive = false;
		};
	}, []);

	const handlePairingInput = useCallback(
		async (raw: string, invalidMessage: string) => {
			setPairingBusy(true);
			setError(null);

			try {
				const parsed = parsePairingUrl(raw);
				if (!parsed) {
					logPairing("input-parse-failed", {
						rawLength: raw.length,
						prefix: raw.slice(0, 32),
					});
					throw new Error(invalidMessage);
				}

				logPairing("input-parsed", {
					baseUrl: parsed.baseUrl,
					originalScheme: parsed.originalUrl.split(":")[0],
					token: tokenSummary(parsed.token),
				});
				await validatePairing(parsed);
				logPairing("input-validated", { baseUrl: parsed.baseUrl });
				await savePairing(parsed);
				logPairing("input-saved", { baseUrl: parsed.baseUrl });
				setPairing(parsed);
				setScannerOpen(false);
			} catch (scanError) {
				logPairing(
					"input-failed",
					{
						message:
							scanError instanceof Error
								? scanError.message
								: String(scanError),
					},
					"warn",
				);
				setError(
					scanError instanceof Error ? scanError.message : "Pairing failed.",
				);
			} finally {
				setPairingBusy(false);
			}
		},
		[],
	);

	const handleScan = useCallback(
		(raw: string) =>
			handlePairingInput(raw, "This QR code is not a Helmor pairing code."),
		[handlePairingInput],
	);

	const handleManualPairing = useCallback(
		(raw: string) =>
			handlePairingInput(raw, "This is not a Helmor pairing link."),
		[handlePairingInput],
	);

	useEffect(() => {
		let alive = true;

		Linking.getInitialURL()
			.then((url) => {
				if (alive && url) void handleManualPairing(url);
			})
			.catch(() => {
				if (alive) setError("Pairing link could not be opened.");
			});

		const subscription = Linking.addEventListener("url", ({ url }) => {
			void handleManualPairing(url);
		});

		return () => {
			alive = false;
			subscription.remove();
		};
	}, [handleManualPairing]);

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
				busy={pairingBusy}
				error={!scannerOpen ? error : null}
				onOpenScanner={() => {
					setError(null);
					setScannerOpen(true);
				}}
				onSubmitLink={handleManualPairing}
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

function logPairing(
	message: string,
	details?: Record<string, unknown> | null,
	level: "info" | "warn" = "info",
) {
	const logger = level === "warn" ? console.warn : console.log;
	logger(`${LOG_PREFIX} ${message}`, details ?? {});
}

function tokenSummary(token: string): string {
	return `${token.length} chars, suffix=${token.slice(-4)}`;
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
