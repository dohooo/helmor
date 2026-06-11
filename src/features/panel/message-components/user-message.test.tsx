import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { serializeMessageForClipboard } from "./copy-message";
import { ChatUserMessage } from "./user-message";

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
