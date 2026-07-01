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

	it("connecting → ready on a healthy /v1/health", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => healthResponse(200)),
		);
		beginTeamReadinessProbe();
		expect(getTeamReadiness().state).toBe("connecting");
		await vi.advanceTimersByTimeAsync(100);
		expect(getTeamReadiness().state).toBe("ready");
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
