// BROKER_ENC_KEY provisioning decision logic (round6 P1-1b). The hard safety
// constraint under test: the key is written ONLY when confidently absent —
// every inconclusive path must land on "fail", never on "put" (a blind put
// rotates the key and bricks every stored identity).
import { describe, expect, it } from "vitest";
import {
	decideBrokerKeyAction,
	parseSecretList,
	toSecretListOutcome,
} from "../scripts/broker-key";

describe("decideBrokerKeyAction — the four branches", () => {
	it("skips when the key already exists (rotation would brick identities)", () => {
		expect(
			decideBrokerKeyAction({
				kind: "ok",
				names: ["HELMOR_COMPANION_TOKEN", "BROKER_ENC_KEY"],
			}),
		).toBe("skip");
	});

	it("puts when the list is readable and the key is absent", () => {
		expect(
			decideBrokerKeyAction({
				kind: "ok",
				names: ["HELMOR_COMPANION_TOKEN", "GITHUB_TOKEN"],
			}),
		).toBe("put");
	});

	it("puts when the Worker doesn't exist yet (fresh account — no secret can exist)", () => {
		// Verbatim wrangler 4.100.0 output shape, ANSI wrapping outside the text.
		expect(
			decideBrokerKeyAction({
				kind: "error",
				output:
					'✘ [ERROR] Worker "helmor-team" not found.\n\n  If this is a new Worker, run `wrangler deploy` first to create it.',
			}),
		).toBe("put");
	});

	it("fails the provision on any other list failure — never blind-writes", () => {
		expect(
			decideBrokerKeyAction({
				kind: "error",
				output: "✘ [ERROR] A request to the Cloudflare API failed (network)",
			}),
		).toBe("fail");
		expect(decideBrokerKeyAction({ kind: "error", output: "" })).toBe("fail");
	});
});

describe("toSecretListOutcome", () => {
	it("maps exit 0 + parseable JSON to ok/names", () => {
		expect(
			toSecretListOutcome({
				code: 0,
				stdout: '[{"name":"BROKER_ENC_KEY","type":"secret_text"}]',
				stderr: "",
			}),
		).toEqual({ kind: "ok", names: ["BROKER_ENC_KEY"] });
	});

	it("maps non-zero exit to error carrying both streams", () => {
		const outcome = toSecretListOutcome({
			code: 1,
			stdout: "partial",
			stderr: "boom",
		});
		expect(outcome.kind).toBe("error");
		expect((outcome as { output: string }).output).toContain("boom");
	});

	it("maps exit 0 with unreadable stdout to error (→ fail, not a guess)", () => {
		const outcome = toSecretListOutcome({
			code: 0,
			stdout: "wrangler had a bad day",
			stderr: "",
		});
		expect(outcome.kind).toBe("error");
		expect(decideBrokerKeyAction(outcome)).toBe("fail");
	});
});

describe("parseSecretList", () => {
	it("parses the wrangler 4.100.0 JSON array shape", () => {
		expect(
			parseSecretList(
				'[\n  {"name":"HELMOR_COMPANION_TOKEN","type":"secret_text"},\n  {"name":"BROKER_ENC_KEY","type":"secret_text"}\n]',
			),
		).toEqual(["HELMOR_COMPANION_TOKEN", "BROKER_ENC_KEY"]);
	});

	it("tolerates banner noise before the array", () => {
		expect(
			parseSecretList(
				'⛅️ wrangler 4.100.0\n────────\n[{"name":"GITHUB_TOKEN","type":"secret_text"}]',
			),
		).toEqual(["GITHUB_TOKEN"]);
	});

	it("returns null for garbage / non-array JSON", () => {
		expect(parseSecretList("not json at all")).toBeNull();
		expect(parseSecretList('{"name":"BROKER_ENC_KEY"}')).toBeNull();
		expect(parseSecretList("")).toBeNull();
	});

	it("drops entries without a string name instead of inventing one", () => {
		expect(
			parseSecretList('[{"name":"A"},{"type":"secret_text"},{"name":42}]'),
		).toEqual(["A"]);
	});
});
