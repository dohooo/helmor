import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __CURSOR_INTERNAL } from "../src/cursor-session-manager.js";
import type { CursorModelParameter } from "../src/session-manager.js";

const {
	computeModelParameterValues,
	modelInfoToProviderInfo,
	buildCursorMessage,
	extToMimeType,
	toCursorMode,
	extractCreatePlanText,
} = __CURSOR_INTERNAL;

describe("plan mode", () => {
	test("toCursorMode: only 'plan' maps to plan; everything else → agent", () => {
		expect(toCursorMode("plan")).toBe("plan");
		expect(toCursorMode("default")).toBe("agent");
		expect(toCursorMode("bypassPermissions")).toBe("agent");
		expect(toCursorMode("acceptEdits")).toBe("agent");
		expect(toCursorMode(undefined)).toBe("agent");
		expect(toCursorMode("")).toBe("agent");
	});

	test("extractCreatePlanText: reads args.plan, null when blank/missing", () => {
		expect(extractCreatePlanText({ args: { plan: "## Plan\n- step 1" } })).toBe(
			"## Plan\n- step 1",
		);
		expect(extractCreatePlanText({ args: { plan: "   " } })).toBeNull();
		expect(extractCreatePlanText({ args: {} })).toBeNull();
		expect(extractCreatePlanText({})).toBeNull();
		expect(extractCreatePlanText({ args: { plan: 42 } })).toBeNull();
	});
});

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

describe("buildCursorMessage — image attachments", () => {
	test("no images → returns plain string (cheapest path)", async () => {
		const msg = await buildCursorMessage("hello world", []);
		expect(msg).toBe("hello world");
	});

	test("image path → SDKUserMessage with base64 data + mimeType", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-img-test-"));
		try {
			const imgPath = join(dir, "shot.png");
			writeFileSync(imgPath, PNG_1X1);
			const msg = await buildCursorMessage("look at this", [imgPath]);
			expect(typeof msg).toBe("object");
			if (typeof msg === "string") throw new Error("expected SDKUserMessage");
			expect(msg.text).toBe("look at this");
			expect(msg.images).toHaveLength(1);
			const img = msg.images?.[0];
			if (!img || !("data" in img)) throw new Error("expected base64 image");
			expect(img.mimeType).toBe("image/png");
			expect(img.data).toBe(PNG_1X1.toString("base64"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unreadable image → degrades to text note, turn still sent", async () => {
		const msg = await buildCursorMessage("see attached", [
			"/nope/does-not-exist.png",
		]);
		expect(typeof msg).toBe("string");
		expect(msg).toContain("see attached");
		expect(msg).toContain("[Image not found:");
	});

	test("extToMimeType maps known extensions, defaults to png", () => {
		expect(extToMimeType("a.jpg")).toBe("image/jpeg");
		expect(extToMimeType("a.JPEG")).toBe("image/jpeg");
		expect(extToMimeType("a.png")).toBe("image/png");
		expect(extToMimeType("a.gif")).toBe("image/gif");
		expect(extToMimeType("a.webp")).toBe("image/webp");
		expect(extToMimeType("a.bmp")).toBe("image/png");
	});
});

// Real `Cursor.models.list` snapshot — pin behavior against actual
// upstream parameter shapes so future API drift surfaces here.
type CachedFixtureEntry = {
	id: string;
	label: string;
	parameters?: CursorModelParameter[];
};
const FIXTURE: CachedFixtureEntry[] = JSON.parse(
	readFileSync(
		join(import.meta.dir, "fixtures/cursor-models-list.json"),
		"utf8",
	),
);

function fixtureEntry(id: string): CachedFixtureEntry {
	const entry = FIXTURE.find((m) => m.id === id);
	if (!entry) throw new Error(`Fixture missing model id: ${id}`);
	return entry;
}

function fixtureParams(id: string): CursorModelParameter[] {
	return fixtureEntry(id).parameters ?? [];
}

// SDK's ModelParameterDefinition is mutable; our wire shape is readonly.
// Deep-clone to satisfy the SDK type when feeding modelInfoToProviderInfo.
type SdkParam = {
	id: string;
	displayName?: string;
	values: { value: string; displayName?: string }[];
};
function sdkParams(id: string): SdkParam[] | undefined {
	const params = fixtureEntry(id).parameters;
	return params
		? (JSON.parse(JSON.stringify(params)) as SdkParam[])
		: undefined;
}

describe("computeModelParameterValues — fixture-driven", () => {
	test("composer-2: only fast, effort silently dropped, no thinking", () => {
		const params = fixtureParams("composer-2");
		expect(computeModelParameterValues(params, "high", true)).toEqual([
			{ id: "fast", value: "true" },
		]);
		expect(computeModelParameterValues(params, "high", false)).toEqual([]);
	});

	test("gpt-5.3-codex: reasoning + fast forwarded, no thinking auto-add", () => {
		const params = fixtureParams("gpt-5.3-codex");
		expect(computeModelParameterValues(params, "extra-high", true)).toEqual([
			{ id: "reasoning", value: "extra-high" },
			{ id: "fast", value: "true" },
		]);
	});

	test("gpt-5.3-codex: invalid effort value silently dropped", () => {
		const params = fixtureParams("gpt-5.3-codex");
		expect(computeModelParameterValues(params, "max", false)).toEqual([]);
	});

	test("claude-opus-4-7: thinking auto-on, effort surfaced, no fast", () => {
		const params = fixtureParams("claude-opus-4-7");
		// Just effort — thinking still auto-added.
		expect(computeModelParameterValues(params, "high", false)).toEqual([
			{ id: "effort", value: "high" },
			{ id: "thinking", value: "true" },
		]);
		// No effort, no fast — thinking alone.
		expect(computeModelParameterValues(params, undefined, false)).toEqual([
			{ id: "thinking", value: "true" },
		]);
	});

	test("claude-opus-4-6: effort + thinking + fast all forwarded", () => {
		const params = fixtureParams("claude-opus-4-6");
		expect(computeModelParameterValues(params, "high", true)).toEqual([
			{ id: "effort", value: "high" },
			{ id: "thinking", value: "true" },
			{ id: "fast", value: "true" },
		]);
	});

	test("claude-haiku-4-5: only thinking; effort/fast dropped", () => {
		const params = fixtureParams("claude-haiku-4-5");
		expect(computeModelParameterValues(params, "high", true)).toEqual([
			{ id: "thinking", value: "true" },
		]);
	});

	test("claude-sonnet-4-5: thinking auto-on regardless of input", () => {
		const params = fixtureParams("claude-sonnet-4-5");
		expect(computeModelParameterValues(params, undefined, false)).toEqual([
			{ id: "thinking", value: "true" },
		]);
	});

	test("default (Auto): no parameters → no params forwarded", () => {
		const params = fixtureParams("default");
		expect(params).toEqual([]);
		expect(computeModelParameterValues([], "high", true)).toEqual([]);
	});

	test("model with no thinking param → thinking not auto-added", () => {
		// gpt-5.5 has reasoning + fast + context, no thinking.
		const params = fixtureParams("gpt-5.5");
		const result = computeModelParameterValues(params, undefined, false);
		expect(result.find((p) => p.id === "thinking")).toBeUndefined();
	});

	test("effort precedence: `effort` wins over `reasoning` if both present", () => {
		const params: CursorModelParameter[] = [
			{ id: "effort", values: [{ value: "max" }] },
			{ id: "reasoning", values: [{ value: "high" }] },
		];
		expect(computeModelParameterValues(params, "max", false)).toEqual([
			{ id: "effort", value: "max" },
		]);
	});
});

describe("modelInfoToProviderInfo — fixture-driven", () => {
	test("composer-2 → fast only", () => {
		const info = modelInfoToProviderInfo({
			id: "composer-2",
			displayName: "Composer 2",
			parameters: sdkParams("composer-2"),
		});
		expect(info.effortLevels).toBeUndefined();
		expect(info.supportsFastMode).toBe(true);
	});

	test("gpt-5.3-codex → reasoning levels surfaced as effortLevels + fast", () => {
		const info = modelInfoToProviderInfo({
			id: "gpt-5.3-codex",
			displayName: "Codex 5.3",
			parameters: sdkParams("gpt-5.3-codex"),
		});
		expect(info.effortLevels).toEqual(["low", "medium", "high", "extra-high"]);
		expect(info.supportsFastMode).toBe(true);
	});

	test("claude-opus-4-7 → effort levels exposed; thinking is invisible to UI", () => {
		const info = modelInfoToProviderInfo({
			id: "claude-opus-4-7",
			displayName: "Opus 4.7",
			parameters: sdkParams("claude-opus-4-7"),
		});
		expect(info.effortLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(info.supportsFastMode).toBeUndefined();
	});

	test("claude-opus-4-6 → effort + fast (thinking is invisible)", () => {
		const info = modelInfoToProviderInfo({
			id: "claude-opus-4-6",
			displayName: "Opus 4.6",
			parameters: sdkParams("claude-opus-4-6"),
		});
		expect(info.effortLevels).toEqual(["low", "medium", "high", "max"]);
		expect(info.supportsFastMode).toBe(true);
	});

	test("claude-haiku-4-5 → no toolbar capabilities (thinking auto-on internally)", () => {
		const info = modelInfoToProviderInfo({
			id: "claude-haiku-4-5",
			displayName: "Haiku 4.5",
			parameters: sdkParams("claude-haiku-4-5"),
		});
		expect(info.effortLevels).toBeUndefined();
		expect(info.supportsFastMode).toBeUndefined();
	});

	test("default (Auto) → no parameters → no toolbar capabilities", () => {
		const info = modelInfoToProviderInfo({
			id: "default",
			displayName: "Auto",
			parameters: sdkParams("default"),
		});
		expect(info.effortLevels).toBeUndefined();
		expect(info.supportsFastMode).toBeUndefined();
		expect(info.cursorParameters).toBeUndefined();
	});

	test("entire upstream catalog round-trips without error", () => {
		for (const model of FIXTURE) {
			const info = modelInfoToProviderInfo({
				id: model.id,
				displayName: model.label,
				parameters: sdkParams(model.id),
			});
			expect(info.id).toBe(model.id);
			expect(info.label).toBe(model.label);
		}
	});
});
