// verifyLive's health-poll retry semantics (round6 F-C). The bug under test:
// a 401 from the freshly-rotated admin token is Cloudflare secret propagation
// lag (measured ~3-10s live), NOT a permanent mismatch — verify must keep
// polling within the grace window instead of hard-failing on the first 401.
import { describe, expect, it } from "vitest";
import {
	AUTH_PROPAGATION_GRACE_MS,
	HEALTH_POLL_INTERVAL_MS,
	type HealthProbeResult,
	pollHealth,
} from "../scripts/verify-live";

/** Fake clock: `sleep` advances time instantly, `now` reads it. */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

/** Probe returning `results` in order, repeating the last one forever. */
function scriptedProbe(results: HealthProbeResult[]) {
	let calls = 0;
	return {
		calls: () => calls,
		probe: async () => {
			const i = Math.min(calls, results.length - 1);
			calls += 1;
			return results[i];
		},
	};
}

const TIMEOUT_MS = 180_000;

describe("pollHealth — 401 during the secret propagation window (F-C core)", () => {
	it("keeps polling through a 401 that turns 200 within the grace window", async () => {
		// Live-measured shape: 401 for ~3-10s after rotate+deploy, then 200.
		const probe = scriptedProbe([
			{ ok: false, status: 401 },
			{ ok: false, status: 401 },
			{ ok: false, status: 401 },
			{ ok: true, status: 200 },
		]);
		const clock = fakeClock();

		const err = await pollHealth({
			probe: probe.probe,
			timeoutMs: TIMEOUT_MS,
			...clock,
		});

		expect(err).toBeNull();
		expect(probe.calls()).toBe(4);
	});

	it("still fails with a named auth error when the 401 outlives the grace window", async () => {
		const probe = scriptedProbe([{ ok: false, status: 401 }]);
		const clock = fakeClock();

		const err = await pollHealth({
			probe: probe.probe,
			timeoutMs: TIMEOUT_MS,
			...clock,
		});

		expect(err).toContain("Worker auth");
		expect(err).toContain("401");
		// It must have actually waited out the window, not failed on probe #1.
		expect(probe.calls()).toBeGreaterThan(1);
		expect(clock.now()).toBeGreaterThanOrEqual(AUTH_PROPAGATION_GRACE_MS);
	});

	it("403 gets the same grace as 401", async () => {
		const probe = scriptedProbe([
			{ ok: false, status: 403 },
			{ ok: true, status: 200 },
		]);

		const err = await pollHealth({
			probe: probe.probe,
			timeoutMs: TIMEOUT_MS,
			...fakeClock(),
		});

		expect(err).toBeNull();
	});
});

describe("pollHealth — unchanged semantics around the grace window", () => {
	it("a permanent container error fails immediately — no grace, no retry", async () => {
		const probe = scriptedProbe([
			{ ok: false, status: 500, permanent: true, message: "image pull failed" },
		]);
		const clock = fakeClock();

		const err = await pollHealth({
			probe: probe.probe,
			timeoutMs: TIMEOUT_MS,
			...clock,
		});

		expect(err).toBe("Container start: image pull failed");
		expect(probe.calls()).toBe(1);
		expect(clock.now()).toBe(0);
	});

	it("the total deadline still caps a cold start that never finishes", async () => {
		// Network errors (no status) poll until the overall timeout.
		const probe = scriptedProbe([{ ok: false, message: "fetch failed" }]);
		const clock = fakeClock();

		const err = await pollHealth({
			probe: probe.probe,
			timeoutMs: 30_000,
			...clock,
		});

		expect(err).toContain("didn't finish starting in time");
		expect(clock.now()).toBeGreaterThanOrEqual(30_000);
		expect(probe.calls()).toBe(30_000 / HEALTH_POLL_INTERVAL_MS + 1);
	});
});
