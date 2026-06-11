import { useCallback, useEffect, useState } from "react";

import { saveOnboardingCompleted } from "../features/onboarding/onboarding-store";
import type { NativePairing } from "../lib/pairing";
import { validatePairing } from "../lib/pairing";
import { clearPairing, loadPairing } from "../lib/pairing-store";

const LOG_PREFIX = "[helmor-mobile:pairing]";

export function useMobileBootState() {
	const [booting, setBooting] = useState(true);
	const [pairing, setPairing] = useState<NativePairing | null>(null);
	const [bootError, setBootError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;

		loadPairing()
			.then(async (saved) => {
				logPairing("stored-pairing-loaded", {
					hasPairing: !!saved,
					baseUrl: saved?.baseUrl ?? null,
					token: saved ? tokenSummary(saved.token) : null,
				});
				if (!saved) return;

				try {
					await validatePairing(saved, 5_000);
					logPairing("stored-pairing-validated", {
						baseUrl: saved.baseUrl,
					});
					if (alive) setPairing(saved);
				} catch (validationError) {
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
						setBootError(
							"Saved Helmor link is no longer reachable. Paste a fresh pairing link from the desktop app.",
						);
					}
				}
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
				if (alive) setBootError("Stored pairing could not be restored.");
			})
			.finally(() => {
				if (alive) setBooting(false);
			});

		return () => {
			alive = false;
		};
	}, []);

	const completeOnboarding = useCallback(async () => {
		await saveOnboardingCompleted();
	}, []);

	return {
		bootError,
		booting,
		completeOnboarding,
		pairing,
		setBootError,
		setPairing,
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
