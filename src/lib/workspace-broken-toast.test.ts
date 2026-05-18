// Phase 22d test: the destructive "Workspace directory is missing"
// toast names the bound remote so the operator can tell which host's
// workspace they're about to permanently delete. Local-bound and
// host-agnostic calls fall back to the legacy copy.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { showWorkspaceBrokenToast } from "./workspace-broken-toast";

function setupToastSpy() {
	const pushToast = vi.fn();
	const queryClient = new QueryClient();
	return { pushToast, queryClient };
}

describe("showWorkspaceBrokenToast (phase 22d host naming)", () => {
	it("falls back to host-agnostic copy when runtimeName is missing", () => {
		const { pushToast, queryClient } = setupToastSpy();
		showWorkspaceBrokenToast({
			workspaceId: "ws-1",
			pushToast,
			queryClient,
		});
		expect(pushToast).toHaveBeenCalledTimes(1);
		const [message, title] = pushToast.mock.calls[0];
		expect(title).toBe("Workspace directory is missing");
		expect(message).toContain("Permanently delete to remove it");
		expect(message).not.toContain("on ");
	});

	it("falls back to host-agnostic copy when runtimeName is local", () => {
		// `"local"` is the local sentinel — the chip / toast should
		// not name "local" as a host because the user wouldn't say
		// "this workspace runs on local".
		const { pushToast, queryClient } = setupToastSpy();
		showWorkspaceBrokenToast({
			workspaceId: "ws-1",
			pushToast,
			queryClient,
			runtimeName: "local",
		});
		const [_message, title] = pushToast.mock.calls[0];
		expect(title).toBe("Workspace directory is missing");
	});

	it("names the host in title + description when runtimeName is remote", () => {
		const { pushToast, queryClient } = setupToastSpy();
		showWorkspaceBrokenToast({
			workspaceId: "ws-1",
			pushToast,
			queryClient,
			runtimeName: "dev.box",
		});
		const [message, title] = pushToast.mock.calls[0];
		expect(title).toBe("Workspace directory is missing on dev.box");
		expect(message).toContain("Permanently delete this workspace on dev.box");
	});

	it("honours an explicit description override regardless of host name", () => {
		// Some callers pass their own message (e.g. when the
		// underlying error has more specific context). The explicit
		// description wins; the title still surfaces the host.
		const { pushToast, queryClient } = setupToastSpy();
		showWorkspaceBrokenToast({
			workspaceId: "ws-1",
			pushToast,
			queryClient,
			runtimeName: "dev.box",
			description: "Caller-provided override",
		});
		const [message, title] = pushToast.mock.calls[0];
		expect(message).toBe("Caller-provided override");
		expect(title).toBe("Workspace directory is missing on dev.box");
	});
});
