import { afterEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
	toast: { error: toastError },
}));

import { CompanionAsleepError } from "./companion-asleep";
import { toastCaughtError } from "./error-toast";

afterEach(() => {
	toastError.mockClear();
});

describe("toastCaughtError (DF-R6-A)", () => {
	it("stays SILENT for a typed companion-asleep error", () => {
		toastCaughtError(
			new CompanionAsleepError(),
			"The team sandbox is asleep — showing last-known data until it wakes.",
		);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("toasts a real error with a message-stable id (same text replaces, never stacks)", () => {
		toastCaughtError(new Error("boom"), "boom");
		toastCaughtError(new Error("boom"), "boom");
		expect(toastError).toHaveBeenCalledTimes(2);
		const [firstId, secondId] = toastError.mock.calls.map(
			(call) => (call[1] as { id: string }).id,
		);
		expect(firstId).toBe(secondId);
		expect(toastError.mock.calls[0][0]).toBe("boom");
	});

	it("gives different messages different ids and forwards extra options", () => {
		toastCaughtError(new Error("a"), "message a");
		toastCaughtError(new Error("b"), "message b", { description: "detail" });
		const [idA, idB] = toastError.mock.calls.map(
			(call) => (call[1] as { id: string }).id,
		);
		expect(idA).not.toBe(idB);
		expect(toastError.mock.calls[1][1]).toMatchObject({
			description: "detail",
		});
	});
});
