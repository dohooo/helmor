import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import {
	ActiveThreadViewport,
	type PresentedSessionPane,
} from "./thread-viewport";

vi.mock("streamdown", () => ({
	Streamdown: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	defaultRehypePlugins: { raw: () => {}, harden: () => {} },
}));

vi.mock("@/components/streamdown-components", () => ({
	streamdownComponents: {},
}));

function message(id: string, streaming = false): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		createdAt: new Date(0).toISOString(),
		streaming,
		content: [{ type: "text", text: `message ${id}` }],
	};
}

describe("ActiveThreadViewport", () => {
	afterEach(() => cleanup());

	it("keeps content-visibility disabled for conversation rows", async () => {
		const messages = Array.from({ length: 13 }, (_, index) =>
			message(`history-${index}`),
		);
		messages.push(message("streaming-tail", true));

		const pane: PresentedSessionPane = {
			sessionId: "session-1",
			messages,
			sending: true,
			hasLoaded: true,
			presentationState: "presented",
		};

		render(
			<QueryClientProvider client={createHelmorQueryClient()}>
				<ActiveThreadViewport hasSession pane={pane} />
			</QueryClientProvider>,
		);

		const historyRow = await screen.findByText("message history-0");
		const streamingRow = await screen.findByText("message streaming-tail");

		expect(historyRow.closest(".flow-root")).not.toHaveStyle({
			contentVisibility: "auto",
		});
		expect(streamingRow.closest(".flow-root")).not.toHaveStyle({
			contentVisibility: "auto",
		});
	});
});
