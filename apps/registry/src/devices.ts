/// Device register/revoke logic. Anonymous by design: a device record holds no
/// user identity — only the hostname, the CF record id, a hashed secret, and
/// the tunnel UUID.

import { createCname, deleteRecord } from "./cf";
import {
	base32,
	base64url,
	constantTimeEqual,
	randomBytes,
	sha256Hex,
} from "./crypto";
import type { Env } from "./env";

export interface DeviceRecord {
	hostname: string;
	recordId: string;
	secretHash: string;
	tunnelUuid: string;
	createdAt: string;
	lastSeenAt: string;
}

export interface RegisterResult {
	deviceId: string;
	hostname: string;
	secret: string;
}

/** A failure that maps to a specific HTTP status. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerDevice(
	env: Env,
	tunnelUuid: string,
): Promise<RegisterResult> {
	if (!UUID_RE.test(tunnelUuid)) {
		throw new HttpError(400, "Invalid tunnelUuid");
	}

	const prefix = env.HOSTNAME_PREFIX ?? "remote-";
	const hostname = `${prefix}${base32(randomBytes(5))}.${env.ROOT_DOMAIN}`;
	// Defense-in-depth: even with a zone-wide token, never touch anything
	// outside the companion namespace.
	assertGuardedHostname(env, hostname);

	const recordId = await createCname(
		env,
		hostname,
		`${tunnelUuid}.cfargotunnel.com`,
	);

	const deviceId = crypto.randomUUID();
	const secret = `hsec_${base64url(randomBytes(18))}`;
	const now = new Date().toISOString();
	const record: DeviceRecord = {
		hostname,
		recordId,
		secretHash: await sha256Hex(secret),
		tunnelUuid,
		createdAt: now,
		lastSeenAt: now,
	};
	await env.DEVICES.put(deviceKey(deviceId), JSON.stringify(record));

	return { deviceId, hostname, secret };
}

export async function revokeDevice(
	env: Env,
	deviceId: string,
	secret: string,
): Promise<void> {
	const raw = await env.DEVICES.get(deviceKey(deviceId));
	if (!raw) throw new HttpError(404, "Unknown device");

	const record = JSON.parse(raw) as DeviceRecord;
	const providedHash = await sha256Hex(secret);
	if (!constantTimeEqual(providedHash, record.secretHash)) {
		throw new HttpError(401, "Invalid device secret");
	}

	assertGuardedHostname(env, record.hostname);
	await deleteRecord(env, record.recordId);
	await env.DEVICES.delete(deviceKey(deviceId));
}

function assertGuardedHostname(env: Env, hostname: string): void {
	const prefix = env.HOSTNAME_PREFIX ?? "remote-";
	const re = new RegExp(
		`^${escapeRe(prefix)}[a-z2-7]{1,32}\\.${escapeRe(env.ROOT_DOMAIN)}$`,
	);
	if (!re.test(hostname)) {
		throw new HttpError(500, "Refusing to operate on a non-companion hostname");
	}
}

function escapeRe(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deviceKey(deviceId: string): string {
	return `device:${deviceId}`;
}
