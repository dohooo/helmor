import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getTeamConfig: vi.fn((): { url: string; token: string } | null => ({
		url: "https://team.example.workers.dev",
		token: "tok",
	})),
}));
vi.mock("./team-mode", () => ({ getTeamConfig: mocks.getTeamConfig }));

import {
	beginTeamReadinessProbe,
	getTeamReadiness,
	resetTeamReadiness,
} from "./team-readiness";

const healthResponse = (status: number, message = "") =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({ message }),
	}) as unknown as Response;

describe("team-readiness", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.getTeamConfig.mockReturnValue({
			url: "https://team.example.workers.dev",
			token: "tok",
		});
		resetTeamReadiness();
	});
	afterEach(() => {
		resetTeamReadiness();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("connecting → ready on a 200 model-catalog answer (WP5 probe)", async () => {
		const fetchMock = vi.fn(async () => healthResponse(200));
		vi.stubGlobal("fetch", fetchMock);
		beginTeamReadinessProbe();
		expect(getTeamReadiness().state).toBe("connecting");
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("ready");
		// WP5: the probe is the model-catalog RPC — answered by the Worker's D1
		// cache with the container asleep — NOT /v1/health (which proxied through
		// ensureServe and itself woke the container).
		const [probeUrl, probeInit] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(probeUrl).toBe(
			"https://team.example.workers.dev/rpc/list_agent_model_sections",
		);
		expect(probeInit.method).toBe("POST");
		expect((probeInit.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
	});

	it("degrades terminally (unauthorized) on 401", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => healthResponse(401)),
		);
		beginTeamReadinessProbe();
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("degraded");
		expect(getTeamReadiness().unauthorized).toBe(true);
	});

	it("stays connecting on a 503 cold start, then degrades past the ceiling", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => healthResponse(503, "serve host not ready")),
		);
		beginTeamReadinessProbe();
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("connecting");
		await vi.advanceTimersByTimeAsync(185_000);
		expect(getTeamReadiness().state).toBe("degraded");
		expect(getTeamReadiness().unauthorized).toBe(false);
	});

	it("degrades FAST (not stuck connecting) on a permanent container error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: false,
						status: 503,
						json: async () => ({
							permanent: true,
							message:
								"Container failed to start due to a permanent error (startup).",
						}),
					}) as unknown as Response,
			),
		);
		beginTeamReadinessProbe();
		// Well before the 180s cold-start ceiling: a permanent error must NOT
		// look like a cold start.
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("degraded");
		// Retryable (re-run setup may fix), NOT terminal-unauthorized.
		expect(getTeamReadiness().unauthorized).toBe(false);
		expect(getTeamReadiness().label).toMatch(/can't start/i);
	});

	it("degrades (unreachable, retryable) on sustained network errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		beginTeamReadinessProbe();
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("connecting");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(getTeamReadiness().state).toBe("degraded");
		expect(getTeamReadiness().unauthorized).toBe(false);
	});

	it("is unconfigured when no team config is present", () => {
		mocks.getTeamConfig.mockReturnValue(null);
		beginTeamReadinessProbe();
		expect(getTeamReadiness().state).toBe("unconfigured");
	});
});
