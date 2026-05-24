import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
	listWorkspaceChanges: vi.fn(),
	listWorkspaceFiles: vi.fn(),
	readEditorFile: vi.fn(),
	readFileAtRef: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => {
	let fileValue = "";
	let changeHandler: ((value: string) => void) | null = null;

	const fileController = {
		dispose: vi.fn(),
		focus: vi.fn(),
		getValue: vi.fn(() => fileValue),
		onDidChangeModelContent: vi.fn((callback: (value: string) => void) => {
			changeHandler = callback;
			return { dispose: vi.fn() };
		}),
		revealPosition: vi.fn(),
		setValue: vi.fn((value: string) => {
			fileValue = value;
		}),
		switchFile: vi.fn(
			(_path: string, content?: string, _line?: number, _column?: number) => {
				if (content !== undefined) {
					fileValue = content;
				}
				return true;
			},
		),
	};

	const diffController = {
		dispose: vi.fn(),
		focus: vi.fn(),
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
			this.diffController.focus.mockClear();
			this.diffController.setTexts.mockClear();
			this.fileController.dispose.mockClear();
			this.fileController.focus.mockClear();
			this.fileController.getValue.mockClear();
			this.fileController.onDidChangeModelContent.mockClear();
			this.fileController.revealPosition.mockClear();
			this.fileController.setValue.mockClear();
			this.fileController.switchFile.mockClear();
			this.syncVirtualFile.mockClear();
		},
		syncVirtualFile: vi.fn(async () => undefined),
	};
});

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();

	return {
		...actual,
		listWorkspaceChanges: apiMocks.listWorkspaceChanges,
		listWorkspaceFiles: apiMocks.listWorkspaceFiles,
		readEditorFile: apiMocks.readEditorFile,
		readFileAtRef: apiMocks.readFileAtRef,
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
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			}),
	);

	return (
		<QueryClientProvider client={queryClient}>
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
		</QueryClientProvider>
	);
}

describe("WorkspaceEditorSurface", () => {
	beforeEach(() => {
		runtimeMocks.reset();
		apiMocks.listWorkspaceChanges.mockReset();
		apiMocks.listWorkspaceChanges.mockResolvedValue([]);
		apiMocks.listWorkspaceFiles.mockReset();
		apiMocks.readEditorFile.mockReset();
		apiMocks.readFileAtRef.mockReset();
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

	it("switches a diff into file edit mode from the toolbar", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "diff",
						path: "/tmp/helmor-workspace/src/App.tsx",
						fileStatus: "M",
						originalText: "const value = 1;\n",
						modifiedText: "const value = 2;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createDiffEditor).toHaveBeenCalled();
		});

		await user.click(screen.getByRole("button", { name: "Edit" }));

		expect(onChangeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				dirty: false,
				kind: "file",
				path: "/tmp/helmor-workspace/src/App.tsx",
			}),
		);
	});

	it("opens workspace files from the file tab search", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.listWorkspaceFiles.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 0,
				unstagedDeletions: 0,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/utils.ts",
			content: "export const value = 1;\n",
			mtimeMs: 20,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "diff",
						path: "/tmp/helmor-workspace/src/App.tsx",
						fileStatus: "M",
						originalText: "const value = 1;\n",
						modifiedText: "const value = 2;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await user.click(screen.getByRole("button", { name: "Open file" }));
		await user.type(
			screen.getByPlaceholderText("Search files"),
			"utils{enter}",
		);

		await waitFor(() => {
			expect(apiMocks.readEditorFile).toHaveBeenCalledWith(
				"/tmp/helmor-workspace/src/utils.ts",
			);
			expect(onChangeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "file",
					path: "/tmp/helmor-workspace/src/utils.ts",
					modifiedText: "export const value = 1;\n",
				}),
			);
		});
	});

	it("keeps opened files as selectable tabs", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.listWorkspaceFiles.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 0,
				unstagedDeletions: 0,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/utils.ts",
			content: "export const value = 1;\n",
			mtimeMs: 20,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/App.tsx",
						originalText: "const app = 1;\n",
						modifiedText: "const app = 1;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await user.click(screen.getByRole("button", { name: "Open file" }));
		await user.keyboard("{Enter}");

		await waitFor(() => {
			expect(screen.getByRole("tab", { name: /utils\.ts/ })).toHaveAttribute(
				"data-state",
				"active",
			);
		});

		await user.click(screen.getByRole("tab", { name: /App\.tsx/ }));

		expect(onChangeSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "file",
				path: "/tmp/helmor-workspace/src/App.tsx",
			}),
		);
	});

	it("opens changed search results as a diff tab", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.listWorkspaceFiles.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 3,
				unstagedDeletions: 1,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.listWorkspaceChanges.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 3,
				unstagedDeletions: 1,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/App.tsx",
						originalText: "const app = 1;\n",
						modifiedText: "const app = 1;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await user.click(screen.getByRole("button", { name: "Open file" }));
		await user.type(
			screen.getByPlaceholderText("Search files"),
			"utils{enter}",
		);

		await waitFor(() => {
			expect(onChangeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: "diff",
					path: "/tmp/helmor-workspace/src/utils.ts",
					fileStatus: "M",
				}),
			);
		});
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

	it("settles keyboard focus inside the editor surface after first render", async () => {
		// Real invariant being protected: after the editor mounts, focus must
		// be somewhere inside [data-focus-scope=editor] so Cmd+E/T/W resolve
		// to the editor scope without a manual click. Whether the focus ends
		// up on Monaco's textarea, the surface container, or an internal tab
		// is an implementation detail — the only thing that matters is that
		// it's NOT stranded outside the surface (e.g. on a changes-list row).
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

		const surface = screen.getByLabelText("Workspace editor surface");
		expect(surface.contains(document.activeElement)).toBe(true);
	});

	it("reclaims focus after switching to another file via search", async () => {
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.listWorkspaceFiles.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 0,
				unstagedDeletions: 0,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/utils.ts",
			content: "export const value = 1;\n",
			mtimeMs: 20,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "file",
						path: "/tmp/helmor-workspace/src/App.tsx",
						originalText: "const app = 1;\n",
						modifiedText: "const app = 1;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createFileEditor).toHaveBeenCalled();
		});

		// First-mount focus already happened; we care about post-switch.
		runtimeMocks.fileController.focus.mockClear();

		await user.click(screen.getByRole("button", { name: "Open file" }));
		await user.type(
			screen.getByPlaceholderText("Search files"),
			"utils{enter}",
		);

		await waitFor(() => {
			expect(runtimeMocks.fileController.switchFile).toHaveBeenCalledWith(
				"/tmp/helmor-workspace/src/utils.ts",
				expect.anything(),
				undefined,
				undefined,
			);
			expect(runtimeMocks.fileController.focus).toHaveBeenCalled();
		});
	});

	it("rebuilds the diff editor on file switch so the first frame is fully rendered", async () => {
		// Why slow path (dispose + createDiffEditor) instead of model-reuse:
		// Monaco computes diffs in a worker. setValue() on an existing diff
		// model defers hunk decorations to a later frame — users see
		// "incomplete first frame, complete second frame". createDiffEditor
		// computes the diff synchronously during construction, so the first
		// post-switch paint is the fully-decorated final result. The Monaco
		// runtime is cached after first use, so the dispose+create round
		// trip resolves inside the same microtask burst (no blank paint).
		const onChangeSpy = vi.fn();
		const user = userEvent.setup();

		apiMocks.listWorkspaceFiles.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 3,
				unstagedDeletions: 1,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.listWorkspaceChanges.mockResolvedValue([
			{
				path: "src/utils.ts",
				absolutePath: "/tmp/helmor-workspace/src/utils.ts",
				name: "utils.ts",
				status: "M",
				stagedInsertions: 0,
				stagedDeletions: 0,
				unstagedInsertions: 3,
				unstagedDeletions: 1,
				committedInsertions: 0,
				committedDeletions: 0,
			},
		]);
		apiMocks.readFileAtRef.mockResolvedValue("export const value = 0;\n");
		apiMocks.readEditorFile.mockResolvedValue({
			path: "/tmp/helmor-workspace/src/utils.ts",
			content: "export const value = 1;\n",
			mtimeMs: 20,
		});

		render(
			<TooltipProvider delayDuration={0}>
				<EditorSurfaceHarness
					initialSession={{
						kind: "diff",
						path: "/tmp/helmor-workspace/src/App.tsx",
						fileStatus: "M",
						originalText: "const app = 1;\n",
						modifiedText: "const app = 2;\n",
					}}
					onChangeSpy={onChangeSpy}
				/>
			</TooltipProvider>,
		);

		await waitFor(() => {
			expect(runtimeMocks.createDiffEditor).toHaveBeenCalledTimes(1);
		});

		await user.click(screen.getByRole("button", { name: "Open file" }));
		await user.type(
			screen.getByPlaceholderText("Search files"),
			"utils{enter}",
		);

		// New file → second createDiffEditor call with the new file's content.
		await waitFor(() => {
			expect(runtimeMocks.createDiffEditor).toHaveBeenCalledTimes(2);
		});
		expect(runtimeMocks.createDiffEditor).toHaveBeenLastCalledWith(
			expect.objectContaining({
				path: "/tmp/helmor-workspace/src/utils.ts",
				originalText: "export const value = 0;\n",
				modifiedText: "export const value = 1;\n",
			}),
		);
		// The old diff controller was disposed as part of the rebuild.
		expect(runtimeMocks.diffController.dispose).toHaveBeenCalled();
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
