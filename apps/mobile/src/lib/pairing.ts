export type NativePairing = {
	baseUrl: string;
	connectionKind: "temporary" | "fixed";
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

	if (url.protocol === "helmor:") {
		const token = url.searchParams.get("pair") ?? url.searchParams.get("token");
		const baseUrlRaw =
			url.searchParams.get("baseUrl") ?? url.searchParams.get("url");
		if (!token?.trim() || !baseUrlRaw?.trim()) return null;

		let baseUrl: URL;
		try {
			baseUrl = new URL(baseUrlRaw);
		} catch {
			return null;
		}
		if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
			return null;
		}

		return {
			baseUrl: baseUrl.origin,
			connectionKind: connectionKindFromUrl(url),
			token: token.trim(),
			pairedAt: now().toISOString(),
			originalUrl: url.toString(),
		};
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") return null;

	const token =
		tokenFromHash(url.hash) ??
		url.searchParams.get("pair") ??
		url.searchParams.get("token");
	if (!token?.trim()) return null;

	return {
		baseUrl: url.origin,
		connectionKind: connectionKindFromUrl(url),
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
		(record.connectionKind === "temporary" ||
			record.connectionKind === "fixed") &&
		typeof record.token === "string" &&
		typeof record.pairedAt === "string" &&
		typeof record.originalUrl === "string"
	);
}

export function normalizeNativePairing(value: unknown): NativePairing | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.baseUrl === "string" &&
		typeof record.token === "string" &&
		typeof record.pairedAt === "string" &&
		typeof record.originalUrl === "string"
	) {
		return {
			baseUrl: record.baseUrl,
			connectionKind: record.connectionKind === "fixed" ? "fixed" : "temporary",
			token: record.token,
			pairedAt: record.pairedAt,
			originalUrl: record.originalUrl,
		};
	}
	return null;
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
				"This Helmor connection is no longer valid. Open Helmor on your computer and scan a new QR code.",
			);
		}
		throw new Error(
			`Helmor rejected the pairing request (${response.status}).`,
		);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				"Helmor did not respond. Keep Helmor open on your computer and try again.",
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

function connectionKindFromUrl(url: URL): NativePairing["connectionKind"] {
	return url.searchParams.get("kind") === "fixed" ? "fixed" : "temporary";
}
