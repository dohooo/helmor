import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSessionState } from "@/lib/editor-session";

const apiMocks = vi.hoisted(() => ({
	readEditorFile: vi.fn(),
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
	});

	afterEach(() => {
		cleanup();
	});

	it("loads a file and tracks dirty state", async () => {
		const onChangeSpy = vi.fn();

		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/App.tsx",
			content: "const value = 1;\n",
			mtimeMs: 10,
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
			expect(
				screen.getByLabelText("Workspace editor surface"),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Editor canvas")).toBeInTheDocument();
			expect(screen.getByText("No such file")).toBeInTheDocument();
		});
	});
});
