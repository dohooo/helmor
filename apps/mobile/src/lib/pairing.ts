export type NativePairing = {
	baseUrl: string;
	token: string;
	pairedAt: string;
	originalUrl: string;
};

export function parsePairingUrl(
	raw: string,
	now: () => Date = () => new Date(),
): NativePairing | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") return null;

	const token =
		tokenFromHash(url.hash) ??
		url.searchParams.get("pair") ??
		url.searchParams.get("token");
	if (!token?.trim()) return null;

	return {
		baseUrl: url.origin,
		token: token.trim(),
		pairedAt: now().toISOString(),
		originalUrl: url.toString(),
	};
}

export function isNativePairing(value: unknown): value is NativePairing {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.baseUrl === "string" &&
		typeof record.token === "string" &&
		typeof record.pairedAt === "string" &&
		typeof record.originalUrl === "string"
	);
}

export async function validatePairing(
	pairing: NativePairing,
	timeoutMs = 12_000,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${pairing.baseUrl}/rpc/get_app_settings`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${pairing.token}`,
				"Content-Type": "application/json",
			},
			body: "{}",
			signal: controller.signal,
		});

		if (response.ok) return;
		if (response.status === 401) {
			throw new Error(
				"This pairing code expired. Create a new code in Helmor.",
			);
		}
		throw new Error(
			`Helmor rejected the pairing request (${response.status}).`,
		);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				"Helmor did not respond. Keep the desktop app open and try again.",
			);
		}
		if (error instanceof Error) throw error;
		throw new Error("Unable to reach Helmor.");
	} finally {
		clearTimeout(timeout);
	}
}

function tokenFromHash(hash: string): string | null {
	const match = hash.match(/(?:^#|[&#?])(?:pair|token)=([^&]+)/);
	if (!match) return null;
	return decodeURIComponent(match[1] ?? "");
}
