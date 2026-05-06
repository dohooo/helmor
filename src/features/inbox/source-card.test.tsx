import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import type { ContextCard } from "@/lib/sources/types";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { SourceCard } from "./source-card";

const card: ContextCard = {
	id: "issue-363",
	source: "github_issue",
	externalId: "fabien0102/ts-to-zod#363",
	externalUrl: "https://github.com/fabien0102/ts-to-zod/issues/363",
	title: "Support tuple optional and rest parameters",
	state: { label: "Open", tone: "open" },
	lastActivityAt: Date.now(),
	meta: {
		type: "github_issue",
		repo: "fabien0102/ts-to-zod",
		number: 363,
		labels: [],
	},
};

describe("SourceCard", () => {
	it("labels the add-to-context button consistently with the detail view", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<WorkspaceToastProvider value={vi.fn()}>
					<ComposerInsertProvider value={vi.fn()}>
						<SourceCard card={card} />
					</ComposerInsertProvider>
				</WorkspaceToastProvider>
			</TooltipProvider>,
		);

		expect(
			screen.getByRole("button", { name: "Add to context" }),
		).toBeInTheDocument();
	});
});
