import { beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, string>();
let shouldThrow = false;

mock.module("expo-secure-store", () => ({
	getItemAsync: async (key: string) => {
		if (shouldThrow) throw new Error("secure store unavailable");
		return store.get(key) ?? null;
	},
	setItemAsync: async (key: string, value: string) => {
		if (shouldThrow) throw new Error("secure store unavailable");
		store.set(key, value);
	},
}));

const { loadOnboardingCompleted, saveOnboardingCompleted } = await import(
	"./onboarding-store"
);

describe("onboarding-store", () => {
	beforeEach(() => {
		store.clear();
		shouldThrow = false;
	});

	it("defaults to incomplete", async () => {
		expect(await loadOnboardingCompleted()).toBe(false);
	});

	it("persists completion", async () => {
		await saveOnboardingCompleted();

		expect(await loadOnboardingCompleted()).toBe(true);
	});

	it("falls back to incomplete when storage cannot be read", async () => {
		shouldThrow = true;

		expect(await loadOnboardingCompleted()).toBe(false);
	});
});
