import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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

// Avoid loading the heavy streamdown bundle in jsdom — render a stub that
// just exposes the source so we can assert preview content was passed in.
vi.mock("@/components/streamdown-loader", () => ({
	LazyStreamdown: ({ children }: { children?: string }) => (
		<div data-testid="streamdown-stub">{children}</div>
	),
	preloadStreamdown: vi.fn(),
}));

import { WorkspaceEditorSurface } from "./index";

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
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/App.tsx",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
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

	it("does not show the markdown toggle for non-markdown files", async () => {
		const onChangeSpy = vi.fn();

		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/App.tsx",
			content: "const value = 1;\n",
			mtimeMs: 10,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/App.tsx",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		expect(screen.queryByLabelText("Markdown view mode")).toBeNull();
	});

	it("shows source/preview toggle for .md files and starts in source mode by default", async () => {
		const onChangeSpy = vi.fn();

		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/SPEC.md",
			content: "# Title\n\nbody",
			mtimeMs: 10,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/SPEC.md",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(screen.getByLabelText("Markdown view mode")).toBeInTheDocument();
		});

		const sourceItem = screen.getByRole("tab", { name: "Source" });
		const previewItem = screen.getByRole("tab", { name: "Preview" });
		expect(sourceItem).toHaveAttribute("data-state", "active");
		expect(previewItem).toHaveAttribute("data-state", "inactive");
		expect(screen.queryByLabelText("Markdown preview")).toBeNull();
	});

	it("starts in preview mode when the session has viewMode: preview", async () => {
		const onChangeSpy = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/SPEC.md",
						viewMode: "preview",
						originalText: "# Hello\n",
						modifiedText: "# Hello\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		const previewRegion = await screen.findByLabelText("Markdown preview");
		expect(previewRegion).toBeInTheDocument();
		expect(screen.getByTestId("streamdown-stub")).toHaveTextContent("# Hello");

		// Monaco host stays mounted but is hidden.
		const canvas = screen.getByLabelText("Editor canvas");
		expect(canvas).toHaveAttribute("aria-hidden", "true");
	});

	it("toggles between source and preview when the user clicks the buttons", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/SPEC.md",
			content: "# Title\n",
			mtimeMs: 10,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/SPEC.md",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		await user.click(screen.getByRole("tab", { name: "Preview" }));

		await waitFor(() => {
			expect(screen.getByLabelText("Markdown preview")).toBeInTheDocument();
		});
		expect(screen.getByTestId("streamdown-stub")).toHaveTextContent("# Title");

		await user.click(screen.getByRole("tab", { name: "Source" }));

		await waitFor(() => {
			expect(screen.queryByLabelText("Markdown preview")).toBeNull();
		});
	});

	it("toggles preview via ⌘⇧V keyboard shortcut", async () => {
		const onChangeSpy = vi.fn();

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/SPEC.md",
						viewMode: "source",
						originalText: "# Hi",
						modifiedText: "# Hi",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		fireEvent.keyDown(window, { key: "V", metaKey: true, shiftKey: true });

		await waitFor(() => {
			expect(screen.getByLabelText("Markdown preview")).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: "v", metaKey: true, shiftKey: true });

		await waitFor(() => {
			expect(screen.queryByLabelText("Markdown preview")).toBeNull();
		});
	});

	it("surfaces read failures without breaking the shell", async () => {
		const onChangeSpy = vi.fn();
		const onError = vi.fn();

		apiMocks.readEditorFile.mockRejectedValue(new Error("No such file"));

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/missing.ts",
					}}
					onChangeSpy={onChangeSpy}
					onError={onError}
				/>
			</TooltipProvider>,
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
