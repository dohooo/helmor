// WP5 (D2): control-plane model-catalog cache — payload validation, D1
// read/write (incl. the self-healing pre-WP5 path), the post-wake refresh, and
// the local-proxy intercept (cache hit answers WITHOUT touching the companion;
// a miss falls through and writes through).

import type { Sandbox } from "@cloudflare/sandbox";
import { describe, expect, it } from "vitest";
import { type Env, refreshModelCatalog } from "../src/index";
import { createLocalTeamProxy } from "../src/local-dev/proxy";
import { InMemoryLocalTeamRegistry } from "../src/local-dev/registry";
import {
	MODEL_CATALOG_HEADER,
	MODEL_CATALOG_RPC,
	parseModelCatalogPayload,
	readModelCatalog,
	writeModelCatalog,
} from "../src/model-catalog";

const CATALOG = JSON.stringify([
	{ id: "claude", label: "Claude", status: "ready", options: [] },
	{ id: "codex", label: "Codex", status: "ready", options: [] },
]);

describe("parseModelCatalogPayload", () => {
	it("accepts a JSON array of section objects, verbatim", () => {
		expect(parseModelCatalogPayload(CATALOG)).toBe(CATALOG);
	});

	it("rejects non-arrays, arrays of non-objects, and invalid JSON", () => {
		// Error envelopes / partial bodies must never become the durable catalog.
		expect(parseModelCatalogPayload('{"code":"Unavailable"}')).toBeNull();
		expect(parseModelCatalogPayload('["a","b"]')).toBeNull();
		expect(parseModelCatalogPayload("[{")).toBeNull();
	});
});

/** Minimal in-memory D1 fake: real enough for prepare/bind/first/batch, and it
 *  starts WITHOUT the model_catalog table so the self-healing CREATE (a pre-WP5
 *  D1) is exercised by the write path. */
function fakeD1() {
	const rows = new Map<string, { payload: string; updated_at: string }>();
	let tableExists = false;
	const statement = (sql: string) => {
		let bound: unknown[] = [];
		const stmt = {
			bind: (...args: unknown[]) => {
				bound = args;
				return stmt;
			},
			first: async () => {
				if (!tableExists) throw new Error("no such table: model_catalog");
				const row = rows.get(String(bound[0]));
				return row ? { payload: row.payload } : null;
			},
			run: async () => {
				if (sql.startsWith("CREATE TABLE IF NOT EXISTS model_catalog")) {
					tableExists = true;
					return;
				}
				if (!tableExists) throw new Error("no such table: model_catalog");
				rows.set(String(bound[0]), {
					payload: String(bound[1]),
					updated_at: String(bound[2]),
				});
			},
			_sql: sql,
		};
		return stmt;
	};
	return {
		rows,
		db: {
			prepare: (sql: string) => statement(sql),
			batch: async (stmts: Array<{ run: () => Promise<void> }>) => {
				for (const s of stmts) await s.run();
			},
		} as unknown as D1Database,
	};
}

describe("model-catalog D1 cache", () => {
	it("write→read round-trips; a missing table reads as a MISS, not an error", async () => {
		const { db } = fakeD1();
		// Pre-WP5 D1: table absent → read must be a clean null (cache miss).
		expect(await readModelCatalog(db, "sb-1")).toBeNull();
		// Write self-heals the table, then upserts.
		await writeModelCatalog(db, "sb-1", CATALOG);
		expect(await readModelCatalog(db, "sb-1")).toBe(CATALOG);
	});

	it("stores catalog METADATA only — the row has no credential fields", async () => {
		const { db, rows } = fakeD1();
		await writeModelCatalog(db, "sb-1", CATALOG);
		const stored = rows.get("sb-1");
		expect(Object.keys(stored ?? {}).sort()).toEqual(["payload", "updated_at"]);
		expect(stored?.payload).not.toMatch(/token|secret|auth/i);
	});
});

describe("refreshModelCatalog (post-wake invalidation)", () => {
	const makeEnv = (db: D1Database): Env =>
		({
			DB: db,
			HELMOR_SANDBOX_ID: "sb-refresh",
			HELMOR_COMPANION_TOKEN: "companion-token",
		}) as unknown as Env;

	it("pulls the catalog from the live container and upserts the cache", async () => {
		const { db } = fakeD1();
		const requests: Request[] = [];
		const sandbox = {
			containerFetch: async (target: string, init: RequestInit) => {
				requests.push(new Request(target, init));
				return new Response(CATALOG, {
					headers: { "content-type": "application/json" },
				});
			},
		} as unknown as Sandbox;

		await refreshModelCatalog(sandbox, makeEnv(db), 8080);

		expect(requests).toHaveLength(1);
		expect(new URL(requests[0].url).pathname).toBe(MODEL_CATALOG_RPC);
		expect(requests[0].headers.get("Authorization")).toBe(
			"Bearer companion-token",
		);
		expect(await readModelCatalog(db, "sb-refresh")).toBe(CATALOG);
	});

	it("leaves the previous cache row on a non-OK / invalid container answer", async () => {
		const { db } = fakeD1();
		await writeModelCatalog(db, "sb-refresh", CATALOG);
		const sandbox = {
			containerFetch: async () =>
				new Response('{"code":"Unavailable"}', { status: 503 }),
		} as unknown as Sandbox;

		await refreshModelCatalog(sandbox, makeEnv(db), 8080);

		expect(await readModelCatalog(db, "sb-refresh")).toBe(CATALOG);
	});
});

// ── Local-proxy intercept (same semantics as the Worker's D1 intercept) ──────

const ADMIN_TOKEN = "hlm_local_admin_test";
const COMPANION_TOKEN = "hlm_local_companion_test";
const PUBLIC_URL = "http://127.0.0.1:8787";

function makeProxy() {
	const registry = new InMemoryLocalTeamRegistry();
	let companionCalls = 0;
	const proxy = createLocalTeamProxy({
		registry,
		companionBaseUrl: "http://companion.local:8080",
		companionToken: COMPANION_TOKEN,
		adminToken: ADMIN_TOKEN,
		publicBaseUrl: PUBLIC_URL,
		fetchCompanion: async () => {
			companionCalls += 1;
			return new Response(CATALOG, {
				headers: { "content-type": "application/json" },
			});
		},
	});
	return {
		proxy,
		registry,
		companionCalls: () => companionCalls,
	};
}

const catalogRequest = (token?: string) =>
	new Request(`${PUBLIC_URL}${MODEL_CATALOG_RPC}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: "{}",
	});

describe("local proxy model-catalog intercept", () => {
	it("miss → live pass + write-through; second call is a no-companion cache hit", async () => {
		const { proxy, registry, companionCalls } = makeProxy();

		const first = await proxy.fetch(catalogRequest(COMPANION_TOKEN));
		expect(first.status).toBe(200);
		expect(first.headers.get(MODEL_CATALOG_HEADER)).toBeNull();
		expect(companionCalls()).toBe(1);
		expect(registry.getModelCatalog()).toBe(CATALOG);

		const second = await proxy.fetch(catalogRequest(COMPANION_TOKEN));
		expect(second.status).toBe(200);
		expect(second.headers.get(MODEL_CATALOG_HEADER)).toBe("cached");
		expect(await second.json()).toEqual(JSON.parse(CATALOG));
		// The container ("companion") was NOT consulted for the cached answer.
		expect(companionCalls()).toBe(1);
	});

	it("rejects an unauthenticated catalog request (401) even on a warm cache", async () => {
		const { proxy, registry } = makeProxy();
		registry.setModelCatalog(CATALOG);
		const res = await proxy.fetch(catalogRequest());
		expect(res.status).toBe(401);
	});
});
