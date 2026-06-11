import { useCallback, useState } from "react";

import type { NativePairing } from "../lib/pairing";
import { parsePairingUrl, validatePairing } from "../lib/pairing";
import { savePairing } from "../lib/pairing-store";

const LOG_PREFIX = "[helmor-mobile:pairing]";

type PairingControllerOptions = {
	onPaired: (pairing: NativePairing) => void;
};

type PairingInputOptions = {
	onSuccess?: () => void | Promise<void>;
};

export function usePairingController({ onPaired }: PairingControllerOptions) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submitPairingInput = useCallback(
		async (
			raw: string,
			invalidMessage: string,
			options: PairingInputOptions = {},
		) => {
			setBusy(true);
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
				await options.onSuccess?.();
				onPaired(parsed);
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
				setBusy(false);
			}
		},
		[onPaired],
	);

	const submitScan = useCallback(
		(raw: string, options?: PairingInputOptions) =>
			submitPairingInput(
				raw,
				"This QR code is not a Helmor pairing code.",
				options,
			),
		[submitPairingInput],
	);

	const submitManualLink = useCallback(
		(raw: string, options?: PairingInputOptions) =>
			submitPairingInput(raw, "This is not a Helmor pairing link.", options),
		[submitPairingInput],
	);
	const resetError = useCallback(() => setError(null), []);

	return {
		busy,
		error,
		resetError,
		setError,
		submitManualLink,
		submitPairingInput,
		submitScan,
	};
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
