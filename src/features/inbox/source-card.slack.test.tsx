import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import type { ContextCard } from "@/lib/sources/types";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { SourceCard } from "./source-card";

// Regression gate: every new ContextCard.source variant needs to render
// inside SourceCard without throwing. `slack_thread` lacks numbered
// references (no `#NN` / `!NN`), so the title-suffix branch in
// `buildCardContextLabel` is exercised differently from the forge cards.

const slackCard: ContextCard = {
	id: "T0:C1:1700000000.123456",
	source: "slack_thread",
	externalId: "#eng-frontend",
	externalUrl: "https://helmor.slack.com/archives/C1/p1700000000123456",
	title: "@caspian can you take a look at this build?",
	subtitle: "Michael",
	lastActivityAt: Date.now(),
	meta: {
		type: "slack_thread",
		workspaceName: "Helmor",
		channelName: "#eng-frontend",
		rootAuthor: { name: "Michael" },
	},
};

describe("SourceCard (slack)", () => {
	it("renders a slack_thread card with the channel label visible", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<WorkspaceToastProvider value={vi.fn()}>
					<ComposerInsertProvider value={vi.fn()}>
						<SourceCard card={slackCard} />
					</ComposerInsertProvider>
				</WorkspaceToastProvider>
			</TooltipProvider>,
		);

		// Channel label is rendered as the externalId line under the title.
		expect(screen.getByText("#eng-frontend")).toBeInTheDocument();
		// The title text reaches the DOM (clamped, but the substring exists).
		expect(screen.getByText(/can you take a look/)).toBeInTheDocument();
		// And the "Add to context" affordance still wires up — proves the
		// label-builder didn't blow up on the absence of a `#NN` suffix.
		expect(
			screen.getByRole("button", { name: "Add to context" }),
		).toBeInTheDocument();
	});
});
