import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard: every `UiMutationEvent` variant declared in `api.ts` must be
 * handled by a `case` in `use-ui-sync-bridge.ts`, or be explicitly allow-listed
 * as handled elsewhere. The bridge's switch has no `default`, so a new backend
 * event with no matching case is silently dropped and the frontend never reacts.
 */
const HANDLED_OUTSIDE_BRIDGE: ReadonlySet<string> = new Set([
	// Consumed by `useRoomPresence` (presence store + ts/TTL self-expiry), not
	// the central invalidation bridge. See backend-contract-presence-unread.md.
	"roomPresenceChanged",
	// Consumed by a dedicated `subscribeUiMutations` listener in
	// `features/conversation/index.tsx` that flips the composer's fast-mode
	// toggle off — not a React Query invalidation, so it lives off the bridge.
	"fastModeUnavailable",
]);

function read(relativeToHere: string): string {
	return readFileSync(
		fileURLToPath(new URL(relativeToHere, import.meta.url)),
		"utf8",
	);
}

function unionVariantTypes(apiSrc: string): string[] {
	const start = apiSrc.indexOf("export type UiMutationEvent =");
	expect(start).toBeGreaterThanOrEqual(0);
	// The union runs until the next top-level `export` declaration.
	const end = apiSrc.indexOf("\nexport ", start + 1);
	const block = apiSrc.slice(start, end === -1 ? undefined : end);
	return [...block.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]);
}

function bridgeCaseTypes(bridgeSrc: string): Set<string> {
	return new Set([...bridgeSrc.matchAll(/case\s+"(\w+)":/g)].map((m) => m[1]));
}

describe("use-ui-sync-bridge coverage", () => {
	it("handles (or allow-lists) every UiMutationEvent variant", () => {
		const variants = unionVariantTypes(read("../../lib/api.ts"));
		const cases = bridgeCaseTypes(read("./use-ui-sync-bridge.ts"));

		expect(variants.length).toBeGreaterThan(10);
		const unhandled = variants.filter(
			(v) => !cases.has(v) && !HANDLED_OUTSIDE_BRIDGE.has(v),
		);
		expect(unhandled).toEqual([]);
	});
});
