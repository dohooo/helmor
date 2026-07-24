import { describe, expect, it } from "vitest";
import { proxyPlainRpcWithDeadline } from "../src/index";

describe("R3-E plain /rpc proxy deadline", () => {
	it("a hung container handler surfaces as a typed 504 instead of hanging the client", async () => {
		const hung = new Promise<Response>(() => {});
		const res = await proxyPlainRpcWithDeadline(
			hung,
			"/rpc/prepare_workspace_from_repo",
			10,
		);
		expect(res.status).toBe(504);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("ContainerRpcTimeout");
		expect(body.message).toContain("prepare_workspace_from_repo");
	});

	it("a fast answer passes through byte-unchanged", async () => {
		const upstream = new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const res = await proxyPlainRpcWithDeadline(
			Promise.resolve(upstream),
			"/rpc/list_workspace_groups",
			50,
		);
		expect(res).toBe(upstream);
	});

	it("a non-timeout rejection propagates untouched", async () => {
		await expect(
			proxyPlainRpcWithDeadline(
				Promise.reject(new Error("boom")),
				"/rpc/x",
				50,
			),
		).rejects.toThrow("boom");
	});
});
