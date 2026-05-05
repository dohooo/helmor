import { describe, expect, it } from "vitest";
import {
	__SUBAGENT_IDENTITY_INTERNALS,
	getSubagentIdentity,
} from "./subagent-identity";

const { NICKNAME_POOL, COLOR_POOL, fnv1a } = __SUBAGENT_IDENTITY_INTERNALS;

describe("fnv1a", () => {
	it("returns a uint32 (no negative, no overflow)", () => {
		for (const input of ["", "a", "thread_main", "019df5f2-7a2e-7eb0"]) {
			const h = fnv1a(input);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(2 ** 32);
			expect(Number.isInteger(h)).toBe(true);
		}
	});

	it("is deterministic — same input → same hash", () => {
		expect(fnv1a("thread_main")).toBe(fnv1a("thread_main"));
		expect(fnv1a("019df5f2-7a2e-7eb0-8137-2cd66efc68fb")).toBe(
			fnv1a("019df5f2-7a2e-7eb0-8137-2cd66efc68fb"),
		);
	});

	it("differentiates similar inputs", () => {
		expect(fnv1a("thread_a")).not.toBe(fnv1a("thread_b"));
	});
});

describe("getSubagentIdentity", () => {
	it("uses Codex-provided nickname when available, marking fallback false", () => {
		const id = getSubagentIdentity("thread_x", "Leibniz");
		expect(id.nickname).toBe("Leibniz");
		expect(id.nicknameIsFallback).toBe(false);
	});

	it("trims whitespace from provided nickname", () => {
		const id = getSubagentIdentity("thread_x", "  Pauli  ");
		expect(id.nickname).toBe("Pauli");
		expect(id.nicknameIsFallback).toBe(false);
	});

	it("falls back to a pool entry when nickname is missing", () => {
		for (const provided of [null, undefined, "", "   "]) {
			const id = getSubagentIdentity("thread_x", provided);
			expect(NICKNAME_POOL).toContain(id.nickname);
			expect(id.nicknameIsFallback).toBe(true);
		}
	});

	it("is stable — same threadId always picks the same fallback + color", () => {
		const a = getSubagentIdentity("019df5f2-7a2e-7eb0", null);
		const b = getSubagentIdentity("019df5f2-7a2e-7eb0", null);
		expect(a).toEqual(b);
	});

	it("color is always a CSS variable reference, regardless of nickname source", () => {
		const fromCodex = getSubagentIdentity("thread_x", "Leibniz");
		const fromFallback = getSubagentIdentity("thread_x", null);
		expect(COLOR_POOL).toContain(fromCodex.color);
		expect(COLOR_POOL).toContain(fromFallback.color);
		// Same threadId → same color even when one path used Codex's nickname
		// and the other used the fallback.
		expect(fromCodex.color).toBe(fromFallback.color);
	});

	it("two different threadIds usually pick different colors", () => {
		// Not a strict guarantee — pools collide — but with 6 colors and 30
		// distinct ids the *distribution* should cover >1 entry.
		const ids = Array.from({ length: 30 }, (_, i) => `thread_${i}`);
		const distinctColors = new Set(
			ids.map((tid) => getSubagentIdentity(tid, null).color),
		);
		expect(distinctColors.size).toBeGreaterThan(1);
	});

	it("two different threadIds usually pick different fallback nicknames", () => {
		const ids = Array.from({ length: 30 }, (_, i) => `thread_${i}`);
		const distinctNames = new Set(
			ids.map((tid) => getSubagentIdentity(tid, null).nickname),
		);
		// 30 ids over 32 pool entries should land on at least ~10 distinct names.
		expect(distinctNames.size).toBeGreaterThan(8);
	});
});
