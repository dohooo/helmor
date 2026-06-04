/// Minimal Cloudflare DNS API client. Only ever creates/deletes CNAME records;
/// the device layer enforces that names stay inside the `remote-*` namespace.

import type { Env } from "./env";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfResult<T> {
	success: boolean;
	errors: unknown[];
	result: T;
}

export class CfError extends Error {
	constructor(
		message: string,
		readonly errors: unknown[],
	) {
		super(message);
		this.name = "CfError";
	}
}

function cfHeaders(env: Env): HeadersInit {
	return {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};
}

/** Create a proxied CNAME (proxying is required for `*.cfargotunnel.com`
 *  routing) and return the record id. */
export async function createCname(
	env: Env,
	name: string,
	content: string,
): Promise<string> {
	const res = await fetch(`${CF_API}/zones/${env.CF_ZONE_ID}/dns_records`, {
		method: "POST",
		headers: cfHeaders(env),
		body: JSON.stringify({
			type: "CNAME",
			name,
			content,
			proxied: true,
			ttl: 1,
			comment: "helmor-companion",
		}),
	});
	const json = (await res.json().catch(() => ({}))) as Partial<
		CfResult<{ id: string }>
	>;
	if (!res.ok || !json.success || !json.result?.id) {
		throw new CfError("Cloudflare CNAME create failed", json.errors ?? []);
	}
	return json.result.id;
}

/** Delete a DNS record by id. A 404 (already gone) is treated as success. */
export async function deleteRecord(env: Env, recordId: string): Promise<void> {
	const res = await fetch(
		`${CF_API}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
		{ method: "DELETE", headers: cfHeaders(env) },
	);
	if (res.ok || res.status === 404) return;
	const json = (await res.json().catch(() => ({}))) as Partial<
		CfResult<unknown>
	>;
	throw new CfError("Cloudflare record delete failed", json.errors ?? []);
}
