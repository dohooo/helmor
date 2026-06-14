import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTerminalImeGuard,
	isAbandonedImeAsciiBuffer,
	type TerminalImeGuard,
} from "./terminal-ime";

function keyEvent(type: string, keyCode: number): KeyboardEvent {
	return { type, keyCode } as unknown as KeyboardEvent;
}

function dispatchInput(
	textarea: HTMLTextAreaElement,
	init: { data: string; inputType?: string; isComposing?: boolean },
) {
	textarea.dispatchEvent(
		new InputEvent("input", {
			data: init.data,
			inputType: init.inputType ?? "insertText",
			isComposing: init.isComposing ?? false,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function dispatchCompositionEnd(textarea: HTMLTextAreaElement, data: string) {
	textarea.dispatchEvent(
		new CompositionEvent("compositionend", { data, bubbles: true }),
	);
}

describe("isAbandonedImeAsciiBuffer", () => {
	it("matches a pinyin buffer with segmentation spaces", () => {
		expect(isAbandonedImeAsciiBuffer("ni hao")).toBe(true);
		expect(isAbandonedImeAsciiBuffer("sl dkjf")).toBe(true);
	});

	it("rejects CJK, space-free, and whitespace-only commits", () => {
		expect(isAbandonedImeAsciiBuffer("你好")).toBe(false);
		expect(isAbandonedImeAsciiBuffer("你好 hello")).toBe(false);
		expect(isAbandonedImeAsciiBuffer("nihao")).toBe(false);
		expect(isAbandonedImeAsciiBuffer(" ")).toBe(false);
		expect(isAbandonedImeAsciiBuffer("")).toBe(false);
	});
});

describe("createTerminalImeGuard", () => {
	let textarea: HTMLTextAreaElement;
	let send: ReturnType<typeof vi.fn<(data: string) => void>>;
	let guard: TerminalImeGuard;

	beforeEach(() => {
		vi.useFakeTimers();
		textarea = document.createElement("textarea");
		document.body.appendChild(textarea);
		send = vi.fn<(data: string) => void>();
		guard = createTerminalImeGuard(send);
	});

	afterEach(() => {
		guard.detach();
		textarea.remove();
		vi.useRealTimers();
	});

	describe("dropped insertText (quirk 1)", () => {
		it("forwards an IME instant commit xterm drops while keydown is held", () => {
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 191));
			dispatchInput(textarea, { data: "？" });
			expect(send).toHaveBeenCalledExactlyOnceWith("？");
		});

		it("stays inert when keydown was IME-consumed (keyCode 229)", () => {
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 229));
			dispatchInput(textarea, { data: "？" });
			expect(send).not.toHaveBeenCalled();
		});

		it("stays inert when a keypress already handled the char", () => {
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 65));
			guard.observeKeyEvent(keyEvent("keypress", 97));
			dispatchInput(textarea, { data: "a" });
			expect(send).not.toHaveBeenCalled();
		});

		it("stays inert when xterm preventDefaulted the input event", () => {
			textarea.addEventListener("input", (ev) => ev.preventDefault());
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 191));
			dispatchInput(textarea, { data: "？" });
			expect(send).not.toHaveBeenCalled();
		});

		it("ignores mid-composition input events", () => {
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 191));
			dispatchInput(textarea, { data: "n", isComposing: true });
			expect(send).not.toHaveBeenCalled();
		});

		it("ignores non-insertText input types", () => {
			guard.attach(textarea);
			guard.observeKeyEvent(keyEvent("keydown", 191));
			dispatchInput(textarea, { data: "x", inputType: "insertFromPaste" });
			expect(send).not.toHaveBeenCalled();
		});
	});

	describe("composition commit fallback (quirk 2)", () => {
		it("resends the commit when xterm never delivers it", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "？");
			vi.advanceTimersByTime(100);
			expect(send).toHaveBeenCalledExactlyOnceWith("？");
		});

		it("does nothing when xterm delivers the commit", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "你好");
			expect(guard.filterData("你好")).toBe("你好");
			vi.advanceTimersByTime(100);
			expect(send).not.toHaveBeenCalled();
		});

		it("strips segmentation spaces from a resent abandoned buffer", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "ni hao");
			vi.advanceTimersByTime(100);
			expect(send).toHaveBeenCalledExactlyOnceWith("nihao");
		});

		it("skips the fallback when xterm flushed the composition synchronously", () => {
			guard.attach(textarea);
			guard.filterData("nihao");
			dispatchCompositionEnd(textarea, "nihao");
			vi.advanceTimersByTime(100);
			expect(send).not.toHaveBeenCalled();
		});

		it("skips the fallback for empty compositionend", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "");
			vi.advanceTimersByTime(100);
			expect(send).not.toHaveBeenCalled();
		});
	});

	describe("abandoned buffer strip (quirk 3)", () => {
		it("strips spaces from the commit xterm delivers after compositionend", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "sl dkjf");
			expect(guard.filterData("sl dkjf")).toBe("sldkjf");
		});

		it("strips only the committed prefix when chars were appended", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "ni hao");
			expect(guard.filterData("ni hao2")).toBe("nihao2");
		});

		it("consumes the pending commit after one data event", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "ni hao");
			expect(guard.filterData("ni hao")).toBe("nihao");
			expect(guard.filterData("ni hao")).toBe("ni hao");
		});

		it("leaves non-matching data untouched", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "ni hao");
			expect(guard.filterData("xyz")).toBe("xyz");
		});

		it("leaves CJK commits untouched", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "你好");
			expect(guard.filterData("你好")).toBe("你好");
		});

		it("does not let ESC-prefixed reports consume the pending commit", () => {
			guard.attach(textarea);
			dispatchCompositionEnd(textarea, "ni hao");
			expect(guard.filterData("\x1b[I")).toBe("\x1b[I");
			expect(guard.filterData("ni hao")).toBe("nihao");
		});
	});

	it("detach removes listeners and cancels the fallback", () => {
		guard.attach(textarea);
		dispatchCompositionEnd(textarea, "？");
		guard.detach();
		vi.advanceTimersByTime(100);
		guard.observeKeyEvent(keyEvent("keydown", 191));
		dispatchInput(textarea, { data: "？" });
		expect(send).not.toHaveBeenCalled();
	});
});
