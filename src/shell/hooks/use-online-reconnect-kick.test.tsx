import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	reconnectRemoteRuntime: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteRuntimes: apiMocks.listRemoteRuntimes,
		reconnectRemoteRuntime: apiMocks.reconnectRemoteRuntime,
	};
});

import type { RuntimeEntry } from "@/lib/api";
import {
	__testing__,
	useOnlineReconnectKick,
} from "./use-online-reconnect-kick";

const { kickReconnects } = __testing__;

function entry(
	name: string,
	state: RuntimeEntry["state"],
	isLocal = false,
): RuntimeEntry {
	return { name, isLocal, state };
}

describe("useOnlineReconnectKick", () => {
	beforeEach(() => {
		apiMocks.listRemoteRuntimes.mockReset();
		apiMocks.reconnectRemoteRuntime.mockReset();
		apiMocks.reconnectRemoteRuntime.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kicks every non-Connected remote runtime", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			entry("dev.box", { type: "disconnected", reason: "ssh exit" }),
			entry("staging", { type: "degraded", reason: "slow ping" }),
			entry("prod", { type: "connected" }),
			entry("local", { type: "connected" }, true),
		]);
		await kickReconnects();
		expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledTimes(2);
		expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledWith("dev.box");
		expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledWith("staging");
	});

	it("never touches the local runtime even if marked non-Connected", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			entry("local", { type: "disconnected", reason: "unreachable" }, true),
			entry("remote", { type: "disconnected", reason: "ssh exit" }),
		]);
		await kickReconnects();
		expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledExactlyOnceWith(
			"remote",
		);
	});

	it("no-ops when listRemoteRuntimes fails", async () => {
		apiMocks.listRemoteRuntimes.mockRejectedValue(new Error("ipc down"));
		await kickReconnects();
		expect(apiMocks.reconnectRemoteRuntime).not.toHaveBeenCalled();
	});

	it("swallows individual reconnect failures without aborting the loop", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			entry("a", { type: "disconnected", reason: "x" }),
			entry("b", { type: "disconnected", reason: "y" }),
		]);
		apiMocks.reconnectRemoteRuntime.mockImplementation((name: string) =>
			name === "a"
				? Promise.reject(new Error("boom"))
				: Promise.resolve(undefined),
		);
		await kickReconnects();
		expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledTimes(2);
	});

	it("fires kickReconnects on the OS online event", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			entry("dev.box", { type: "disconnected", reason: "ssh exit" }),
		]);
		const { unmount } = renderHook(() => useOnlineReconnectKick());
		window.dispatchEvent(new Event("online"));
		await waitFor(() =>
			expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledExactlyOnceWith(
				"dev.box",
			),
		);
		unmount();
	});

	it("does not fire after unmount", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			entry("dev.box", { type: "disconnected", reason: "ssh exit" }),
		]);
		const { unmount } = renderHook(() => useOnlineReconnectKick());
		unmount();
		window.dispatchEvent(new Event("online"));
		// Give microtasks a chance to run; nothing should be kicked.
		await Promise.resolve();
		expect(apiMocks.listRemoteRuntimes).not.toHaveBeenCalled();
		expect(apiMocks.reconnectRemoteRuntime).not.toHaveBeenCalled();
	});
});
