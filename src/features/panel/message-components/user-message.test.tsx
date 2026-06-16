import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { consumeAnchoredToggle, resetAnchoredToggle } from "./anchored-toggle";
import { serializeMessageForClipboard } from "./copy-message";
import { ChatUserMessage, resolveAuthorAvatarUrl } from "./user-message";
import { UserMessageExpansionProvider } from "./user-message-expansion";

afterEach(() => {
	cleanup();
	resetAnchoredToggle();
});

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
	function textMessage(text: string): ThreadMessageLike {
		return makeMessage([{ type: "text", id: "t0", text }]);
	}

	// jsdom does no layout, so the truncation probe (scrollHeight >
	// clientHeight on the clamped body) is driven by stubbed geometry:
	// "overflowing" content reports a full height taller than the clamped
	// box, complete content reports them equal. Keyed off the inline clamp
	// style, exactly like the real browser's clamp behaves.
	function stubBodyGeometry({ overflowing }: { overflowing: boolean }) {
		const fullHeight = overflowing ? 980 : 360;
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return fullHeight;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get(this: HTMLElement) {
				const clamped = this.style?.webkitLineClamp !== "";
				return clamped ? Math.min(fullHeight, 560) : fullHeight;
			},
		});
	}

	afterEach(() => {
		delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
		delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
	});

	it("shows no control when nothing is cut off", () => {
		stubBodyGeometry({ overflowing: false });
		render(<ChatUserMessage message={textMessage("short\nmessage")} />);
		expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
	});

	it("clamps cut-off content and expands in place via Show more", () => {
		stubBodyGeometry({ overflowing: true });
		render(<ChatUserMessage message={textMessage("an overflowing body")} />);

		// Collapsed: the body carries the line-clamp style and the browser
		// probe reports a cut-off, so the control shows "Show more".
		const body = screen
			.getByText(/an overflowing body/)
			.closest("p") as HTMLElement;
		expect(body.style.webkitLineClamp).toBe("20");
		const control = screen.getByRole("button", { name: /Show more/ });
		expect(control).toHaveAttribute("aria-expanded", "false");

		// Expand: clamp style drops, control flips to "Show less".
		fireEvent.click(control);
		expect(body.style.webkitLineClamp).toBe("");
		fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
		expect(body.style.webkitLineClamp).toBe("20");
		expect(
			screen.getByRole("button", { name: /Show more/ }),
		).toBeInTheDocument();
	});

	it("re-clamps when the provider's session changes", () => {
		stubBodyGeometry({ overflowing: true });
		const { rerender } = render(
			<UserMessageExpansionProvider sessionId="s1">
				<ChatUserMessage message={textMessage("an overflowing body")} />
			</UserMessageExpansionProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(
			screen.getByRole("button", { name: /Show less/ }),
		).toBeInTheDocument();

		rerender(
			<UserMessageExpansionProvider sessionId="s2">
				<ChatUserMessage message={textMessage("an overflowing body")} />
			</UserMessageExpansionProvider>,
		);
		expect(
			screen.getByRole("button", { name: /Show more/ }),
		).toBeInTheDocument();
	});

	it("marks the anchored-toggle handshake for the viewport when a scroller is present", () => {
		stubBodyGeometry({ overflowing: true });
		render(
			<div className="conversation-scroll-viewport">
				<ChatUserMessage message={textMessage("an overflowing body")} />
			</div>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(consumeAnchoredToggle("user-1")).toBe(true);
		// One-shot: consumed marks don't re-fire.
		expect(consumeAnchoredToggle("user-1")).toBe(false);
	});

	it("does not mark the handshake without a scroller (nothing was pre-compensated)", () => {
		stubBodyGeometry({ overflowing: true });
		render(<ChatUserMessage message={textMessage("an overflowing body")} />);
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(consumeAnchoredToggle("user-1")).toBe(false);
	});

	it("pins the control's viewport position across expand and collapse", () => {
		stubBodyGeometry({ overflowing: true });
		// The anchor reads the control's rect before and after the toggle and
		// offsets the scroller by the delta. Stub the rect off the control's
		// own expanded state: collapsed → top 200, expanded → top 700 (the
		// body above it grew by 500px).
		Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
			configurable: true,
			value(this: HTMLElement) {
				const top = this.getAttribute("aria-expanded") === "true" ? 700 : 200;
				return {
					top,
					y: top,
					left: 0,
					x: 0,
					right: 0,
					bottom: 0,
					width: 0,
					height: 0,
					toJSON: () => ({}),
				} as DOMRect;
			},
		});
		try {
			render(
				<div className="conversation-scroll-viewport">
					<ChatUserMessage message={textMessage("an overflowing body")} />
				</div>,
			);
			const scroller = document.querySelector(
				".conversation-scroll-viewport",
			) as HTMLElement;
			scroller.scrollTop = 1000;

			// Expand: the control's document position moved down 500px, so the
			// scroller follows — the control stays put in the viewport and the
			// content visually unfolds upward.
			fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
			expect(scroller.scrollTop).toBe(1500);

			// Collapse: symmetric.
			fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
			expect(scroller.scrollTop).toBe(1000);
		} finally {
			// Removes the prototype shadow, restoring jsdom's implementation.
			delete (HTMLElement.prototype as { getBoundingClientRect?: unknown })
				.getBoundingClientRect;
		}
	});
});

describe("ChatUserMessage author avatar (team room)", () => {
	// CachedAvatar pulls through React Query; the author-less single-user
	// path never mounts it, so only these author cases need a provider.
	function renderWithQuery(ui: ReactElement) {
		return render(
			<QueryClientProvider client={new QueryClient()}>
				{ui}
			</QueryClientProvider>,
		);
	}

	it("shows the author avatar (initials + name title) when author is present", () => {
		renderWithQuery(
			<ChatUserMessage
				message={{
					id: "u-author-1",
					role: "user",
					content: [{ type: "text", id: "t0", text: "hi team" }],
					author: { id: "alice-1", displayName: "Ada Lovelace" },
				}}
			/>,
		);
		expect(screen.getByText("hi team")).toBeInTheDocument();
		expect(screen.getByTestId("author-avatar")).toBeInTheDocument();
		expect(screen.getByTitle("Ada Lovelace")).toBeInTheDocument();
		expect(screen.getByText("AL")).toBeInTheDocument();
	});

	it("renders no author avatar in single-user mode (author absent)", () => {
		renderWithQuery(
			<ChatUserMessage
				message={{
					id: "u-author-2",
					role: "user",
					content: [{ type: "text", id: "t0", text: "solo prompt" }],
				}}
			/>,
		);
		expect(screen.getByText("solo prompt")).toBeInTheDocument();
		expect(screen.queryByTestId("author-avatar")).toBeNull();
	});

	it("falls back to author-id initials when there is no display name", () => {
		renderWithQuery(
			<ChatUserMessage
				message={{
					id: "u-author-3",
					role: "user",
					content: [{ type: "text", id: "t0", text: "x" }],
					author: { id: "zoe" },
				}}
			/>,
		);
		expect(screen.getByTestId("author-avatar")).toBeInTheDocument();
		expect(screen.getByText("ZO")).toBeInTheDocument();
	});
});

describe("resolveAuthorAvatarUrl", () => {
	it("derives the GitHub avatar from a numeric author id", () => {
		// Team-room authors arrive id-only (GitHub numeric id, no URL); derive
		// the real picture from the id instead of showing only initials.
		expect(resolveAuthorAvatarUrl({ id: "32405058" })).toBe(
			"https://avatars.githubusercontent.com/u/32405058",
		);
	});

	it("prefers an explicit avatarUrl over the derived one", () => {
		expect(
			resolveAuthorAvatarUrl({ id: "32405058", avatarUrl: "https://x/a.png" }),
		).toBe("https://x/a.png");
	});

	it("returns undefined for a non-numeric id with no avatarUrl", () => {
		expect(resolveAuthorAvatarUrl({ id: "alice" })).toBeUndefined();
	});
});
