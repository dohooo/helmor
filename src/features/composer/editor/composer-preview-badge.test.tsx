import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageIcon, Tag } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { ComposerPreviewBadge } from "./composer-preview-badge";

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
	invoke: vi.fn(),
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));

vi.mock("@/components/ai/code-block", () => ({
	CodeBlock: ({ code, language }: { code: string; language?: string }) => (
		<div data-testid="code-block">
			{language ?? "code"}::{code}
		</div>
	),
}));

afterEach(() => {
	cleanup();
});

describe("ComposerPreviewBadge", () => {
	it("shows an image preview on hover when preview data is provided", async () => {
		const user = userEvent.setup();

		renderWithProviders(
			<ComposerPreviewBadge
				icon={
					<ImageIcon
						className="size-3 shrink-0 text-chart-3"
						strokeWidth={1.8}
					/>
				}
				label="CleanShot.png"
				preview={{
					kind: "image",
					title: "CleanShot.png",
					path: "/tmp/CleanShot.png",
				}}
			/>,
		);

		await user.hover(screen.getByText("CleanShot.png"));

		expect(
			await screen.findByRole("img", { name: "CleanShot.png" }),
		).toHaveAttribute("src", "asset://localhost/tmp/CleanShot.png");
	});

	it("does not render a hover preview when preview data is omitted", async () => {
		const user = userEvent.setup();

		renderWithProviders(
			<ComposerPreviewBadge
				icon={
					<Tag
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				}
				label="Selection"
			/>,
		);

		await user.hover(screen.getByText("Selection"));

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("shows a text preview on hover when text preview data is provided", async () => {
		const user = userEvent.setup();

		renderWithProviders(
			<ComposerPreviewBadge
				icon={<Tag className="size-3 shrink-0" strokeWidth={1.8} />}
				label="CI summary"
				preview={{
					kind: "text",
					title: "CI summary",
					text: "Line one\nLine two",
				}}
			/>,
		);

		await user.hover(screen.getByText("CI summary"));

		expect(await screen.findByRole("dialog")).toHaveTextContent(
			/Line one\s+Line two/,
		);
	});

	it("shows a code preview on hover when code preview data is provided", async () => {
		const user = userEvent.setup();

		renderWithProviders(
			<ComposerPreviewBadge
				icon={<Tag className="size-3 shrink-0" strokeWidth={1.8} />}
				label="stack trace"
				preview={{
					kind: "code",
					title: "stack trace",
					language: "ts",
					code: "const value = 1;",
				}}
			/>,
		);

		await user.hover(screen.getByText("stack trace"));

		expect(await screen.findByRole("dialog")).toHaveTextContent("stack trace");
		expect(await screen.findByTestId("code-block")).toHaveTextContent(
			"ts::const value = 1;",
		);
	});
});
