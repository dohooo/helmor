/// Runtime bindings + config for the registry Worker. Real values are injected
/// at deploy time (KV binding + vars in `wrangler.jsonc`, `CF_API_TOKEN` as a
/// Worker secret) — none are committed.
export interface Env {
	/** KV namespace holding device records + per-IP rate-limit counters. */
	DEVICES: KVNamespace;
	/** Cloudflare API token, `Zone:DNS:Edit` scoped to the root zone. Secret. */
	CF_API_TOKEN: string;
	/** Zone ID of `ROOT_DOMAIN` (the parent `helmor.ai` zone). */
	CF_ZONE_ID: string;
	/** Apex domain CNAMEs are created under, e.g. `helmor.ai`. */
	ROOT_DOMAIN: string;
	/** Hostname prefix for companion records. Defaults to `remote-`. */
	HOSTNAME_PREFIX?: string;
	/** Max `register` calls per IP per 24h. Defaults to `10`. */
	REGISTER_RATE_LIMIT?: string;
}
