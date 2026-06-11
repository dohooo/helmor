import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { serializeMessageForClipboard } from "./copy-message";
import { ChatUserMessage } from "./user-message";
import { UserMessageExpansionProvider } from "./user-message-expansion";

afterEach(cleanup);

// First line stays under the 40-char label truncation so the chip shows it
// verbatim.
const PASTE_LABEL = "const first = uniqueMarker();";
const PASTE_BODY = [
	PASTE_LABEL,
	...Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`),
].join("\n");

function makeMessage(parts: ThreadMessageLike["content"]): ThreadMessageLike {
	return { id: "user-1", role: "user", content: parts };
}

describe("ChatUserMessage pasted-text tags", () => {
	it("renders plain text messages unchanged", () => {
		render(
			<ChatUserMessage
				message={makeMessage([
					{ type: "text", id: "t0", text: "short prompt" },
				])}
			/>,
		);
		expect(screen.getByText("short prompt")).toBeInTheDocument();
	});

	it("renders a pasted-text part as a tag chip, not inline content", () => {
		render(
			<ChatUserMessage
				message={makeMessage([
					{ type: "text", id: "t0", text: "帮我看看这个\n" },
					{ type: "pasted-text", id: "p0", text: PASTE_BODY },
				])}
			/>,
		);

		// The instruction text renders normally.
		expect(screen.getByText(/帮我看看这个/)).toBeInTheDocument();
		// The chip shows the paste's first line as its label…
		expect(screen.getByText(PASTE_LABEL)).toBeInTheDocument();
		// …and the paste body is NOT inlined in the bubble.
		expect(screen.queryByText(/const line7 = 7;/)).toBeNull();
	});

	it("keeps file-mention badges alongside pasted tags", () => {
		render(
			<ChatUserMessage
				message={makeMessage([
					{ type: "text", id: "t0", text: "see " },
					{ type: "file-mention", id: "f0", path: "src/lib/api.ts" },
					{ type: "pasted-text", id: "p0", text: PASTE_BODY },
				])}
			/>,
		);
		expect(screen.getByText("api.ts")).toBeInTheDocument();
		expect(screen.getByText(PASTE_LABEL)).toBeInTheDocument();
	});

	it("copy serialization reproduces the full pasted content", () => {
		const message = makeMessage([
			{ type: "text", id: "t0", text: "instruction" },
			{ type: "pasted-text", id: "p0", text: PASTE_BODY },
		]);
		const serialized = serializeMessageForClipboard(message);
		expect(serialized).toContain("instruction");
		expect(serialized).toContain("const line7 = 7;");
	});
});

describe("ChatUserMessage line clamp", () => {
	const lines = (n: number) =>
		Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

	function textMessage(text: string): ThreadMessageLike {
		return makeMessage([{ type: "text", id: "t0", text }]);
	}

	it("shows no clamp control at or under the line limit", () => {
		render(<ChatUserMessage message={textMessage(lines(20))} />);
		expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
	});

	it("clamps over-limit messages and expands in place via Show more", () => {
		render(<ChatUserMessage message={textMessage(lines(30))} />);

		// Clamped: the body carries the line-clamp style and the control
		// shows "Show more".
		const body = screen.getByText(/line 29/).closest("p") as HTMLElement;
		expect(body.style.webkitLineClamp).toBe("20");
		const control = screen.getByRole("button", { name: /Show more/ });
		expect(control).toHaveAttribute("aria-expanded", "false");

		// Expand: clamp style drops, control flips to "Show less".
		fireEvent.click(control);
		expect(body.style.webkitLineClamp).toBe("");
		fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
		expect(body.style.webkitLineClamp).toBe("20");
	});

	it("re-clamps when the provider's session changes", () => {
		const { rerender } = render(
			<UserMessageExpansionProvider sessionId="s1">
				<ChatUserMessage message={textMessage(lines(30))} />
			</UserMessageExpansionProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(
			screen.getByRole("button", { name: /Show less/ }),
		).toBeInTheDocument();

		rerender(
			<UserMessageExpansionProvider sessionId="s2">
				<ChatUserMessage message={textMessage(lines(30))} />
			</UserMessageExpansionProvider>,
		);
		expect(
			screen.getByRole("button", { name: /Show more/ }),
		).toBeInTheDocument();
	});

	it("does not count a pasted tag toward the clamp gate", () => {
		render(
			<ChatUserMessage
				message={makeMessage([
					{ type: "text", id: "t0", text: lines(5) },
					{ type: "pasted-text", id: "p0", text: lines(100) },
				])}
			/>,
		);
		expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
	});
});
