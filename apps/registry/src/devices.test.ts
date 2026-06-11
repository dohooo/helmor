import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HttpError, registerDevice, revokeDevice } from "./devices";
import type { Env } from "./env";

const UUID = "12345678-1234-1234-1234-123456789abc";
const HOSTNAME_RE = /^remote-[a-z2-7]{8}\.helmor\.ai$/;

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
	};
}

function makeEnv(kv: ReturnType<typeof fakeKv>): Env {
	return {
		DEVICES: kv as unknown as KVNamespace,
		CF_API_TOKEN: "test-token",
		CF_ZONE_ID: "zone123",
		ROOT_DOMAIN: "helmor.ai",
		HOSTNAME_PREFIX: "remote-",
		REGISTER_RATE_LIMIT: "10",
	};
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

let lastBody: Record<string, unknown> | null = null;
let lastDeleteUrl: string | null = null;

beforeEach(() => {
	lastBody = null;
	lastDeleteUrl = null;
});

function mockCf() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			lastBody = JSON.parse(String(init.body));
			return new Response(
				JSON.stringify({ success: true, errors: [], result: { id: "rec_1" } }),
				{ status: 200 },
			);
		}
		// DELETE
		lastDeleteUrl = url;
		return new Response(
			JSON.stringify({ success: true, errors: [], result: { id: "rec_1" } }),
			{ status: 200 },
		);
	}) as typeof fetch;
}

describe("registerDevice", () => {
	test("creates a proxied remote-* CNAME and returns hostname + secret", async () => {
		mockCf();
		const kv = fakeKv();
		const out = await registerDevice(makeEnv(kv), UUID);

		expect(out.hostname).toMatch(HOSTNAME_RE);
		expect(out.secret).toMatch(/^hsec_/);
		expect(out.deviceId).toBeTruthy();

		// CF was asked to create the right record.
		expect(lastBody?.type).toBe("CNAME");
		expect(lastBody?.name).toMatch(HOSTNAME_RE);
		expect(lastBody?.content).toBe(`${UUID}.cfargotunnel.com`);
		expect(lastBody?.proxied).toBe(true);

		// The stored record hashes the secret (plaintext never persisted).
		const stored = JSON.parse(kv.store.get(`device:${out.deviceId}`) ?? "{}");
		expect(stored.recordId).toBe("rec_1");
		expect(stored.secretHash).not.toContain(out.secret);
		expect(stored.secretHash).toHaveLength(64);
	});

	test("rejects an invalid tunnelUuid before calling CF", async () => {
		globalThis.fetch = (async () => {
			throw new Error("CF should not be called");
		}) as typeof fetch;
		await expect(
			registerDevice(makeEnv(fakeKv()), "not-a-uuid"),
		).rejects.toBeInstanceOf(HttpError);
	});
});

describe("revokeDevice", () => {
	test("deletes the CF record with a valid secret and clears KV", async () => {
		mockCf();
		const kv = fakeKv();
		const env = makeEnv(kv);
		const out = await registerDevice(env, UUID);

		await revokeDevice(env, out.deviceId, out.secret);

		expect(lastDeleteUrl).toContain("/dns_records/rec_1");
		expect(kv.store.get(`device:${out.deviceId}`)).toBeUndefined();
	});

	test("rejects a wrong secret and keeps the record", async () => {
		mockCf();
		const kv = fakeKv();
		const env = makeEnv(kv);
		const out = await registerDevice(env, UUID);

		await expect(
			revokeDevice(env, out.deviceId, "hsec_wrong"),
		).rejects.toMatchObject({ status: 401 });
		expect(kv.store.get(`device:${out.deviceId}`)).toBeDefined();
	});

	test("404s on an unknown device", async () => {
		await expect(
			revokeDevice(makeEnv(fakeKv()), "nope", "hsec_x"),
		).rejects.toMatchObject({ status: 404 });
	});
});
