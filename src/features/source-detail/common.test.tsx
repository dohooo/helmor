import { openUrl } from "@tauri-apps/plugin-opener";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ComposerInsertRequest } from "@/lib/composer-insert";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import type { ContextCard } from "@/lib/sources/types";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { GitHubDetailPage } from "./common";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const card: ContextCard = {
	id: "github-issue-358",
	source: "github_issue",
	externalId: "fabien0102/ts-to-zod#358",
	externalUrl: "https://github.com/fabien0102/ts-to-zod/issues/358",
	title: "ts error: generated import missing .js extension",
	subtitle: "fabien0102/ts-to-zod",
	state: { label: "Open", tone: "open" },
	lastActivityAt: Date.now(),
	meta: {
		type: "github_issue",
		repo: "fabien0102/ts-to-zod",
		number: 358,
		labels: [],
	},
};

function renderDetail({
	insertIntoComposer = vi.fn<(request: ComposerInsertRequest) => void>(),
}: {
	insertIntoComposer?: (request: ComposerInsertRequest) => void;
} = {}) {
	const pushToast = vi.fn();
	render(
		<TooltipProvider delayDuration={0}>
			<WorkspaceToastProvider value={pushToast}>
				<ComposerInsertProvider value={insertIntoComposer}>
					<GitHubDetailPage
						card={card}
						appendContextTarget={{ contextKey: "start:repo:test" }}
						description={"## Repro\n\nGenerated import is missing `.js`."}
						kindLabel="issue"
					/>
				</ComposerInsertProvider>
			</WorkspaceToastProvider>
		</TooltipProvider>,
	);
	return { insertIntoComposer, pushToast };
}

describe("GitHubDetailPage actions", () => {
	it("uses icon actions instead of the old labeled Open button", () => {
		renderDetail();

		expect(
			screen.queryByRole("button", { name: /^Open$/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Open externally" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Add to context" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Copy markdown" }),
		).toBeInTheDocument();
	});

	it("opens, appends context, and copies the markdown body", async () => {
		const user = userEvent.setup();
		const insertIntoComposer =
			vi.fn<(request: ComposerInsertRequest) => void>();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		renderDetail({ insertIntoComposer });

		await user.click(screen.getByRole("button", { name: "Open externally" }));
		expect(openUrl).toHaveBeenCalledWith(card.externalUrl);

		await user.click(screen.getByRole("button", { name: "Add to context" }));
		expect(insertIntoComposer).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { contextKey: "start:repo:test" },
				behavior: "append",
			}),
		);

		await user.click(screen.getByRole("button", { name: "Copy markdown" }));
		expect(writeText).toHaveBeenCalledWith(
			"## Repro\n\nGenerated import is missing `.js`.",
		);
	});
});
