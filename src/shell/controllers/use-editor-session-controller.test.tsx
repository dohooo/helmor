import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { INDEX_REF } from "@/lib/editor-session";
import { useEditorSessionController } from "./use-editor-session-controller";

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		triggerWorkspaceFetch: vi.fn(),
	};
});

const workspaceRoot = "/tmp/ws-1";
const filePath = `${workspaceRoot}/foo.txt`;

function setup() {
	const enterEditorMode = vi.fn();
	const exitEditorMode = vi.fn();
	const pushToast = vi.fn();
	const hook = renderHook(() =>
		useEditorSessionController({
			pushToast,
			workspaceRootPath: workspaceRoot,
			selectedWorkspaceId: "ws-1",
			enterEditorMode,
			exitEditorMode,
		}),
	);
	return { hook, enterEditorMode, exitEditorMode, pushToast };
}

describe("useEditorSessionController.openFile", () => {
	it("reopens the diff with new refs when the same path is clicked in a different area", () => {
		// Regression for issue #544 follow-up: same file in both Staged and
		// Unstaged. Clicking across areas must swap the diff bases, not freeze
		// on the first area's view.
		const { hook } = setup();

		act(() => {
			hook.result.current.actions.openFile(filePath, {
				fileStatus: "M",
				originalRef: "HEAD",
				modifiedRef: INDEX_REF,
			});
		});
		expect(hook.result.current.state.editorSession).toMatchObject({
			kind: "diff",
			path: filePath,
			originalRef: "HEAD",
			modifiedRef: INDEX_REF,
		});

		act(() => {
			hook.result.current.actions.openFile(filePath, {
				fileStatus: "M",
				originalRef: INDEX_REF,
				modifiedRef: undefined,
			});
		});
		// Same path, different bases → session updates, not stuck on HEAD↔INDEX.
		expect(hook.result.current.state.editorSession).toMatchObject({
			kind: "diff",
			path: filePath,
			originalRef: INDEX_REF,
			modifiedRef: undefined,
		});
		// originalText/modifiedText must be cleared so the editor effect
		// re-fetches against the new refs; otherwise we'd render stale bytes.
		expect(
			hook.result.current.state.editorSession?.originalText,
		).toBeUndefined();
		expect(
			hook.result.current.state.editorSession?.modifiedText,
		).toBeUndefined();
	});

	it("is a no-op when path AND both refs match the current session", () => {
		// Clicking the same row twice should not thrash — keep refs as-is and
		// avoid a re-fetch storm.
		const { hook } = setup();

		act(() => {
			hook.result.current.actions.openFile(filePath, {
				fileStatus: "M",
				originalRef: "HEAD",
				modifiedRef: INDEX_REF,
			});
		});
		const firstSession = hook.result.current.state.editorSession;
		act(() => {
			hook.result.current.actions.openFile(filePath, {
				fileStatus: "M",
				originalRef: "HEAD",
				modifiedRef: INDEX_REF,
			});
		});
		// Identity check: short-circuit must skip setEditorSession entirely.
		expect(hook.result.current.state.editorSession).toBe(firstSession);
	});

	it("opens a fresh diff when switching to a different path", () => {
		const { hook } = setup();
		act(() => {
			hook.result.current.actions.openFile(filePath, { fileStatus: "M" });
		});
		const otherPath = `${workspaceRoot}/bar.txt`;
		act(() => {
			hook.result.current.actions.openFile(otherPath, { fileStatus: "A" });
		});
		expect(hook.result.current.state.editorSession).toMatchObject({
			kind: "diff",
			path: otherPath,
			fileStatus: "A",
			inline: true,
		});
	});
});

describe("useEditorSessionController.openFileReference", () => {
	// Regression cover: clicking a chat link to a file whose diff was just
	// open in the inspector must NOT inherit the diff's `originalText`
	// (which is HEAD/INDEX content, not the working-tree). If it did,
	// dirty-tracking would compare editor bytes against a git-ref baseline
	// and a Save would clobber unstaged work.
	it("does not reuse diff-session texts when transitioning to file mode", () => {
		const { hook } = setup();
		// Stage 1: simulate a fully-loaded diff session for the same path.
		act(() => {
			hook.result.current.actions.openFile(filePath, {
				fileStatus: "M",
				originalRef: "HEAD",
				modifiedRef: INDEX_REF,
			});
		});
		act(() => {
			hook.result.current.actions.changeSession({
				...hook.result.current.state.editorSession!,
				originalText: "HEAD bytes",
				modifiedText: "INDEX bytes",
			});
		});
		// Stage 2: chat-link click → openFileReference for the SAME path.
		act(() => {
			hook.result.current.actions.openFileReference(filePath, 10, 0);
		});
		// File session must be a clean slate — texts cleared, dirty reset.
		// Otherwise canRenderFile=true would skip the disk fetch and the
		// editor would render INDEX bytes as if they were the working tree.
		const session = hook.result.current.state.editorSession;
		expect(session?.kind).toBe("file");
		expect(session?.path).toBe(filePath);
		expect(session?.originalText).toBeUndefined();
		expect(session?.modifiedText).toBeUndefined();
		expect(session?.dirty).toBe(false);
	});

	it("reuses texts when re-opening the same file (file → file)", () => {
		// Counter-example: same-file re-open from chat must NOT throw away
		// the user's dirty edits — that's why the kind guard is "diff →
		// file only", not blanket "always clear".
		const { hook } = setup();
		act(() => {
			hook.result.current.actions.openFileReference(filePath, 1, 1);
		});
		act(() => {
			hook.result.current.actions.changeSession({
				...hook.result.current.state.editorSession!,
				originalText: "disk",
				modifiedText: "user edits",
				dirty: true,
			});
		});
		act(() => {
			hook.result.current.actions.openFileReference(filePath, 20, 5);
		});
		const session = hook.result.current.state.editorSession;
		expect(session?.kind).toBe("file");
		expect(session?.originalText).toBe("disk");
		expect(session?.modifiedText).toBe("user edits");
		expect(session?.dirty).toBe(true);
		expect(session?.line).toBe(20);
		expect(session?.column).toBe(5);
	});
});
