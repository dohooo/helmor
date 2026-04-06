import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSessionState } from "@/lib/editor-session";

const apiMocks = vi.hoisted(() => ({
	readEditorFile: vi.fn(),
	writeEditorFile: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => {
	let fileValue = "";
	let changeHandler: ((value: string) => void) | null = null;

	const fileController = {
		dispose: vi.fn(),
		getValue: vi.fn(() => fileValue),
		onDidChangeModelContent: vi.fn((callback: (value: string) => void) => {
			changeHandler = callback;
			return { dispose: vi.fn() };
		}),
		revealPosition: vi.fn(),
		setValue: vi.fn((value: string) => {
			fileValue = value;
		}),
	};

	const diffController = {
		dispose: vi.fn(),
		setTexts: vi.fn(),
	};

	return {
		createDiffEditor: vi.fn(async () => diffController),
		createFileEditor: vi.fn(
			async (options: { content: string; path: string }) => {
				fileValue = options.content;
				return fileController;
			},
		),
		diffController,
		emitFileChange: (value: string) => {
			fileValue = value;
			changeHandler?.(value);
		},
		fileController,
		reset() {
			fileValue = "";
			changeHandler = null;
			this.createDiffEditor.mockClear();
			this.createFileEditor.mockClear();
			this.diffController.dispose.mockClear();
			this.diffController.setTexts.mockClear();
			this.fileController.dispose.mockClear();
			this.fileController.getValue.mockClear();
			this.fileController.onDidChangeModelContent.mockClear();
			this.fileController.revealPosition.mockClear();
			this.fileController.setValue.mockClear();
			this.syncVirtualFile.mockClear();
		},
		syncVirtualFile: vi.fn(async () => undefined),
	};
});

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		readEditorFile: apiMocks.readEditorFile,
		writeEditorFile: apiMocks.writeEditorFile,
	};
});

vi.mock("@/lib/monaco-runtime", () => ({
	createDiffEditor: runtimeMocks.createDiffEditor,
	createFileEditor: runtimeMocks.createFileEditor,
	syncVirtualFile: runtimeMocks.syncVirtualFile,
}));

import { WorkspaceEditorSurface } from "./workspace-editor-surface";

function EditorSurfaceHarness({
	initialSession,
	onChangeSpy,
	onError,
}: {
	initialSession: EditorSessionState;
	onChangeSpy: (session: EditorSessionState) => void;
	onError?: (description: string, title?: string) => void;
}) {
	const [session, setSession] = useState(initialSession);

	return (
		<WorkspaceEditorSurface
			editorSession={session}
			workspaceRootPath="/tmp/helmor-workspace"
			onChangeSession={(next) => {
				onChangeSpy(next);
				setSession(next);
			}}
			onError={onError}
			onExit={vi.fn()}
		/>
	);
}

describe("WorkspaceEditorSurface", () => {
	beforeEach(() => {
		runtimeMocks.reset();
		apiMocks.readEditorFile.mockReset();
		apiMocks.writeEditorFile.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("loads a file, tracks dirty state, and saves it", async () => {
		const user = userEvent.setup();
		const onChangeSpy = vi.fn();

		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/App.tsx",
			content: "const value = 1;\n",
			mtimeMs: 10,
		});
		apiMocks.writeEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/App.tsx",
			mtimeMs: 20,
		});

		render(
			<EditorSurfaceHarness
				initialSession={{
					kind: "file",
					path: "/tmp/helmor-workspace/src/App.tsx",
				}}
				onChangeSpy={onChangeSpy}
			/>,
		);

		await waitFor(() => {
			expect(apiMocks.readEditorFile).toHaveBeenCalledWith(
				"/tmp/helmor-workspace/src/App.tsx",
			);
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		runtimeMocks.emitFileChange("const value = 2;\n");

		await waitFor(() => {
			expect(onChangeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					dirty: true,
					kind: "file",
					modifiedText: "const value = 2;\n",
				}),
			);
		});

		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(apiMocks.writeEditorFile).toHaveBeenCalledWith(
				"/tmp/helmor-workspace/src/App.tsx",
				"const value = 2;\n",
			);
			expect(runtimeMocks.syncVirtualFile).toHaveBeenCalledWith(
				"/tmp/helmor-workspace/src/App.tsx",
				"const value = 2;\n",
			);
			const latestCall =
				onChangeSpy.mock.calls[onChangeSpy.mock.calls.length - 1]?.[0];
			expect(latestCall).toEqual(
				expect.objectContaining({
					dirty: false,
					kind: "file",
					originalText: "const value = 2;\n",
				}),
			);
		});
	});

	it("switches to diff mode and toggles inline review layout", async () => {
		const user = userEvent.setup();
		const onChangeSpy = vi.fn();

		render(
			<EditorSurfaceHarness
				initialSession={{
					kind: "file",
					path: "/tmp/helmor-workspace/src/App.tsx",
					originalText: "const before = 1;\n",
					modifiedText: "const before = 2;\n",
					dirty: true,
				}}
				onChangeSpy={onChangeSpy}
			/>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		await user.click(
			(await screen.findAllByRole("button", { name: "Open review mock" }))[0],
		);

		await waitFor(() => {
			expect(onChangeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "diff",
					path: "/tmp/helmor-workspace/src/App.tsx",
				}),
			);
			expect(runtimeMocks.createDiffEditor).toHaveBeenCalled();
		});

		await user.click(screen.getByRole("button", { name: "Inline" }));

		await waitFor(() => {
			expect(onChangeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					inline: true,
					kind: "diff",
				}),
			);
		});
	});

	it("surfaces read failures without breaking the shell", async () => {
		const onChangeSpy = vi.fn();
		const onError = vi.fn();

		apiMocks.readEditorFile.mockRejectedValue(new Error("No such file"));

		render(
			<EditorSurfaceHarness
				initialSession={{
					kind: "file",
					path: "/tmp/helmor-workspace/src/missing.ts",
				}}
				onChangeSpy={onChangeSpy}
				onError={onError}
			/>,
		);

		await waitFor(() => {
			expect(onError).toHaveBeenCalledWith("No such file", "File open failed");
			expect(screen.getByText("Editor unavailable")).toBeInTheDocument();
			expect(screen.getByText("No such file")).toBeInTheDocument();
		});
	});
});
