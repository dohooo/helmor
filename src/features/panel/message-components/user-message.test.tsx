import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { ChatUserMessage } from "./user-message";
import { UserMessageExpansionProvider } from "./user-message-expansion";

afterEach(cleanup);

const MARKER_LINE = "const marker = computeUniqueMarkerValue();";

// >500 trimmed chars (the composer badge threshold) → renders collapsed.
const LONG_TEXT = [
	"first instruction line for the label",
	...Array.from({ length: 20 }, () => MARKER_LINE),
].join("\n");

function makeMessage(
	text: string,
	id: string | undefined = "user-1",
): ThreadMessageLike {
	return {
		id,
		role: "user",
		content: [{ type: "text", id: `${id ?? "anon"}-text`, text }],
	};
}

// The full body renders as one <span> per text part; match the marker as a
// substring of the (whitespace-normalized) span text — `getByText` with a
// string/regex would trip over the multi-line content and regex metachars.
function queryFullBody() {
	return screen.queryByText((content) => content.includes(MARKER_LINE), {
		selector: "span",
	});
}

describe("ChatUserMessage collapse", () => {
	it("renders short messages as plain text with no collapse chip", () => {
		render(<ChatUserMessage message={makeMessage("short prompt")} />);

		expect(screen.getByText("short prompt")).toBeInTheDocument();
		expect(screen.queryByRole("button", { expanded: false })).toBeNull();
	});

	it("collapses an over-threshold message to a chip and expands on click", () => {
		render(<ChatUserMessage message={makeMessage(LONG_TEXT)} />);

		// Collapsed: chip with the first-line label and line count, no body.
		const chip = screen.getByRole("button", { expanded: false });
		expect(chip).toHaveTextContent("first instruction line for the label");
		expect(chip).toHaveTextContent("21 lines");
		expect(queryFullBody()).toBeNull();

		// Expand: full text appears, chip flips to expanded.
		fireEvent.click(chip);
		expect(queryFullBody()).toBeInTheDocument();
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();

		// Collapse again.
		fireEvent.click(screen.getByRole("button", { expanded: true }));
		expect(queryFullBody()).toBeNull();
	});

	it("keeps file-mention badges visible while collapsed", () => {
		const message: ThreadMessageLike = {
			id: "user-files",
			role: "user",
			content: [
				{ type: "text", id: "t", text: LONG_TEXT },
				{ type: "file-mention", id: "f", path: "src/lib/api.ts" },
			],
		};
		render(<ChatUserMessage message={message} />);

		expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
		expect(screen.getByText("api.ts")).toBeInTheDocument();
		expect(queryFullBody()).toBeNull();
	});

	it("resets expansion when the provider's session changes", () => {
		const { rerender } = render(
			<UserMessageExpansionProvider sessionId="s1">
				<ChatUserMessage message={makeMessage(LONG_TEXT)} />
			</UserMessageExpansionProvider>,
		);

		fireEvent.click(screen.getByRole("button", { expanded: false }));
		expect(queryFullBody()).toBeInTheDocument();

		// Same message identity under a new session → collapsed again.
		rerender(
			<UserMessageExpansionProvider sessionId="s2">
				<ChatUserMessage message={makeMessage(LONG_TEXT)} />
			</UserMessageExpansionProvider>,
		);
		expect(queryFullBody()).toBeNull();
		expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
	});

	it("keeps expansion state per message id under the provider", () => {
		render(
			<UserMessageExpansionProvider sessionId="s1">
				<ChatUserMessage message={makeMessage(LONG_TEXT, "user-a")} />
				<ChatUserMessage message={makeMessage(LONG_TEXT, "user-b")} />
			</UserMessageExpansionProvider>,
		);

		const chips = screen.getAllByRole("button", { expanded: false });
		expect(chips).toHaveLength(2);

		fireEvent.click(chips[0] as HTMLElement);
		// One expanded, one still collapsed.
		expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
		expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
	});
});
