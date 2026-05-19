// Phase 20d frontend tests: the inspector wrappers in `lib/api.ts`
// route through the binding-aware Tauri commands and forward
// `workspaceId` so a workspace pinned to a remote runtime fans the
// call out over the wire. We assert by spying on Tauri's `invoke`:
// the wire-level invariants we care about are command name +
// arguments, both observable here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: invokeMock,
}));

import {
	discardWorkspaceFile,
	getWorkspaceChanges,
	getWorkspaceFileTree,
	listWorkspaceChangesWithContent,
	listWorkspaceFiles,
	mutateWorkspaceFile,
	readFileAtRef,
	readWorkspaceFile,
	readWorkspaceFileAtRef,
	stageWorkspaceFile,
	statWorkspaceFile,
	toWorkspaceRelativePath,
	unstageWorkspaceFile,
	writeWorkspaceFile,
} from "./api";

beforeEach(() => {
	invokeMock.mockReset();
});

describe("getWorkspaceFileTree", () => {
	it("invokes get_workspace_file_tree with the workspace + binding context", async () => {
		invokeMock.mockResolvedValue({ entries: [] });
		await getWorkspaceFileTree("/ws", "ws-1", "remote.box");
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_file_tree", {
			workspaceDir: "/ws",
			workspaceId: "ws-1",
			runtimeName: "remote.box",
		});
	});

	it("omits binding context when neither arg is supplied (local fallback)", async () => {
		invokeMock.mockResolvedValue({ entries: [] });
		await getWorkspaceFileTree("/ws");
		// The wrapper still forwards both keys with `undefined` so the
		// backend's resolver short-circuits to local — this is the
		// contract the resolver relies on (it treats `undefined` and
		// missing identically).
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_file_tree", {
			workspaceDir: "/ws",
			workspaceId: undefined,
			runtimeName: undefined,
		});
	});
});

describe("getWorkspaceChanges", () => {
	it("forwards include_content as a wire-level boolean", async () => {
		invokeMock.mockResolvedValue({ items: [], prefetched: [] });
		await getWorkspaceChanges("/ws", true, "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_changes", {
			workspaceDir: "/ws",
			includeContent: true,
			workspaceId: "ws-1",
			runtimeName: undefined,
		});

		await getWorkspaceChanges("/ws", false, "ws-1");
		expect(invokeMock).toHaveBeenLastCalledWith("get_workspace_changes", {
			workspaceDir: "/ws",
			includeContent: false,
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});
});

describe("readWorkspaceFile", () => {
	it("forwards relative path + workspaceId to read_workspace_file", async () => {
		invokeMock.mockResolvedValue({
			path: "/ws/src/main.rs",
			content: "fn main() {}",
			mtimeMs: 7,
		});
		const result = await readWorkspaceFile("/ws", "src/main.rs", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("read_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "src/main.rs",
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
		expect(result.content).toBe("fn main() {}");
	});

	it("wraps invoke errors with a user-facing message", async () => {
		invokeMock.mockRejectedValue(new Error("ENOENT: missing"));
		await expect(readWorkspaceFile("/ws", "missing.rs")).rejects.toThrow(
			/Unable to open the selected file|ENOENT/,
		);
	});
});

describe("readWorkspaceFileAtRef", () => {
	it("extracts the content field from the wire result", async () => {
		invokeMock.mockResolvedValue({ content: "base body\n" });
		const result = await readWorkspaceFileAtRef(
			"/ws",
			"src/main.rs",
			"HEAD",
			"ws-1",
		);
		expect(result).toBe("base body\n");
		expect(invokeMock).toHaveBeenCalledWith("read_workspace_file_at_ref", {
			workspaceDir: "/ws",
			relativePath: "src/main.rs",
			gitRef: "HEAD",
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("returns null when the backend reports the path missing at that ref", async () => {
		invokeMock.mockResolvedValue({ content: null });
		const result = await readWorkspaceFileAtRef(
			"/ws",
			"never.rs",
			"HEAD",
			"ws-1",
		);
		expect(result).toBeNull();
	});
});

describe("statWorkspaceFile", () => {
	it("forwards workspaceId + relative path", async () => {
		invokeMock.mockResolvedValue({
			path: "/ws/file.txt",
			exists: true,
			isFile: true,
			mtimeMs: 1,
			size: 12,
		});
		await statWorkspaceFile("/ws", "file.txt", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("stat_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "file.txt",
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});
});

describe("mutateWorkspaceFile", () => {
	it("forwards a write action with the content payload intact", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: 999 });
		const result = await mutateWorkspaceFile(
			"/ws",
			"file.txt",
			{ type: "write", content: "new body" },
			"ws-1",
		);
		expect(invokeMock).toHaveBeenCalledWith("mutate_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "file.txt",
			action: { type: "write", content: "new body" },
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
		expect(result.mtimeMs).toBe(999);
	});

	it("forwards each non-write action variant verbatim", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: null });
		for (const action of [
			{ type: "discard" } as const,
			{ type: "stage" } as const,
			{ type: "unstage" } as const,
		]) {
			await mutateWorkspaceFile("/ws", "file.txt", action, "ws-1");
			expect(invokeMock).toHaveBeenLastCalledWith("mutate_workspace_file", {
				workspaceDir: "/ws",
				relativePath: "file.txt",
				action,
				workspaceId: "ws-1",
				runtimeName: undefined,
			});
		}
	});
});

describe("legacy wrappers route through new commands", () => {
	it("listWorkspaceFiles calls get_workspace_file_tree and unwraps entries", async () => {
		invokeMock.mockResolvedValue({
			entries: [
				{
					path: "src/a.rs",
					absolutePath: "/ws/src/a.rs",
					name: "a.rs",
					status: "M",
					stagedInsertions: 0,
					stagedDeletions: 0,
					unstagedInsertions: 0,
					unstagedDeletions: 0,
					committedInsertions: 0,
					committedDeletions: 0,
				},
			],
		});
		const items = await listWorkspaceFiles("/ws", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_file_tree", {
			workspaceDir: "/ws",
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
		expect(items).toHaveLength(1);
		expect(items[0]?.path).toBe("src/a.rs");
	});

	it("listWorkspaceChangesWithContent forwards include_content=true", async () => {
		invokeMock.mockResolvedValue({ items: [], prefetched: [] });
		await listWorkspaceChangesWithContent("/ws", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("get_workspace_changes", {
			workspaceDir: "/ws",
			includeContent: true,
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("readFileAtRef strips an absolute workspace prefix before forwarding", async () => {
		// Legacy callers (editor surface, diff viewer) hand the wrapper an
		// absolute file path. The new backend command takes a relative
		// path, so the wrapper must strip the workspace prefix or the
		// seam-level sandbox rejects the call.
		invokeMock.mockResolvedValue({ content: "base body" });
		await readFileAtRef("/ws", "/ws/src/main.rs", "HEAD", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("read_workspace_file_at_ref", {
			workspaceDir: "/ws",
			relativePath: "src/main.rs",
			gitRef: "HEAD",
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("readFileAtRef passes a relative path through unchanged", async () => {
		invokeMock.mockResolvedValue({ content: "base body" });
		await readFileAtRef("/ws", "src/main.rs", "HEAD");
		expect(invokeMock).toHaveBeenCalledWith("read_workspace_file_at_ref", {
			workspaceDir: "/ws",
			relativePath: "src/main.rs",
			gitRef: "HEAD",
			workspaceId: undefined,
			runtimeName: undefined,
		});
	});

	it("stageWorkspaceFile routes through mutate_workspace_file with action=stage", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: null });
		await stageWorkspaceFile("/ws", "src/a.rs", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("mutate_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "src/a.rs",
			action: { type: "stage" },
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("unstageWorkspaceFile routes through mutate_workspace_file with action=unstage", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: null });
		await unstageWorkspaceFile("/ws", "src/a.rs", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("mutate_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "src/a.rs",
			action: { type: "unstage" },
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("discardWorkspaceFile routes through mutate_workspace_file with action=discard", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: null });
		await discardWorkspaceFile("/ws", "src/a.rs", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("mutate_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "src/a.rs",
			action: { type: "discard" },
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
	});

	it("writeWorkspaceFile routes through mutate_workspace_file with action=write", async () => {
		invokeMock.mockResolvedValue({ mtimeMs: 7 });
		const result = await writeWorkspaceFile("/ws", "src/a.rs", "new", "ws-1");
		expect(invokeMock).toHaveBeenCalledWith("mutate_workspace_file", {
			workspaceDir: "/ws",
			relativePath: "src/a.rs",
			action: { type: "write", content: "new" },
			workspaceId: "ws-1",
			runtimeName: undefined,
		});
		expect(result.mtimeMs).toBe(7);
	});
});

describe("toWorkspaceRelativePath", () => {
	it("strips an absolute workspace prefix", () => {
		expect(
			toWorkspaceRelativePath("/Users/dev/ws", "/Users/dev/ws/src/main.rs"),
		).toBe("src/main.rs");
	});

	it("handles a trailing slash on the root", () => {
		expect(
			toWorkspaceRelativePath("/Users/dev/ws/", "/Users/dev/ws/src/main.rs"),
		).toBe("src/main.rs");
	});

	it("passes a relative path through unchanged", () => {
		expect(toWorkspaceRelativePath("/Users/dev/ws", "src/main.rs")).toBe(
			"src/main.rs",
		);
	});

	it("passes an unrelated absolute path through unchanged (backend sandbox rejects)", () => {
		// A path outside the workspace can't be normalised — leave it
		// for the backend's seam-level sandbox to reject with a clear
		// error rather than silently rewriting it.
		expect(toWorkspaceRelativePath("/Users/dev/ws", "/etc/passwd")).toBe(
			"/etc/passwd",
		);
	});
});
