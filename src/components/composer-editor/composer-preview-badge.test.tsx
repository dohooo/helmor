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
});
