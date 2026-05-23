import { describe, expect, it } from "vitest";
import { BUILTIN_EMOJI } from "@/lib/slack-emoji-builtin";
import {
	formatSlackTextPlain,
	resolveEmoji,
	type SlackEmoji,
	stripSkinTone,
} from "./slack-text";

function emojiTable(): Record<string, SlackEmoji> {
	const out: Record<string, SlackEmoji> = {};
	for (const [name, char] of Object.entries(BUILTIN_EMOJI)) {
		out[name] = { kind: "unicode", char };
	}
	return out;
}

describe("formatSlackTextPlain", () => {
	it("returns empty input as empty string", () => {
		expect(formatSlackTextPlain("")).toBe("");
	});

	it("rewrites <@USER|name> mentions to @name", () => {
		expect(formatSlackTextPlain("hi <@U08P4HCEJS1|james> all")).toBe(
			"hi @james all",
		);
	});

	it("rewrites label-less <@USER> mentions to @USER", () => {
		expect(formatSlackTextPlain("ping <@U12345ABCDE>")).toBe(
			"ping @U12345ABCDE",
		);
	});

	it("rewrites <#CHAN|name> channel mentions to #name", () => {
		expect(formatSlackTextPlain("see <#C03|eng-frontend>")).toBe(
			"see #eng-frontend",
		);
	});

	it("rewrites <url|label> to label only", () => {
		expect(
			formatSlackTextPlain(
				"docs at <https://example.com/very-long-path|the docs>",
			),
		).toBe("docs at the docs");
	});

	it("keeps bare <url> URLs but strips the angle brackets", () => {
		expect(formatSlackTextPlain("more <https://example.com>")).toBe(
			"more https://example.com",
		);
	});

	it("collapses newlines into single spaces so chip text fits one line", () => {
		expect(formatSlackTextPlain("hi <@U1|james>\n\ngg y'all!")).toBe(
			"hi @james gg y'all!",
		);
	});

	it("leaves `:emoji:` shortcodes alone when no emoji table is provided", () => {
		expect(formatSlackTextPlain("nice :joy: shot")).toBe("nice :joy: shot");
	});

	it("resolves `:emoji:` to unicode when the emoji table is provided", () => {
		expect(
			formatSlackTextPlain("nice :joy: shot", { emoji: emojiTable() }),
		).toBe("nice 😂 shot");
	});

	it("leaves unknown `:emoji:` intact even when a table is provided", () => {
		expect(
			formatSlackTextPlain("custom :zzz_nonexistent_zzz: emoji", {
				emoji: emojiTable(),
			}),
		).toBe("custom :zzz_nonexistent_zzz: emoji");
	});

	it("trims leading/trailing whitespace after token replacement", () => {
		expect(formatSlackTextPlain("   <@U1|caspian>   ")).toBe("@caspian");
	});

	it("handles the full Slack-style sample from the offsite thread", () => {
		const raw =
			"<@U08P4HCEJS1|james> wouldn't shut up :joy:\n\nLet's go Team <@U08KK7P7X71|spencer>";
		expect(formatSlackTextPlain(raw, { emoji: emojiTable() })).toBe(
			"@james wouldn't shut up 😂 Let's go Team @spencer",
		);
	});
});

describe("stripSkinTone", () => {
	it("removes -skin-tone-N suffix", () => {
		expect(stripSkinTone("raised_hands-skin-tone-3")).toBe("raised_hands");
		expect(stripSkinTone("heart_hands-skin-tone-6")).toBe("heart_hands");
	});

	it("returns names unchanged when no suffix is present", () => {
		expect(stripSkinTone("raised_hands")).toBe("raised_hands");
	});
});

describe("resolveEmoji", () => {
	it("returns the unicode entry for built-in shortcodes", () => {
		const result = resolveEmoji("joy", emojiTable());
		expect(result).toEqual({ kind: "unicode", char: "😂" });
	});

	it("falls back to base name for skin-tone variants", () => {
		const result = resolveEmoji("raised_hands-skin-tone-3", emojiTable());
		expect(result).toEqual({ kind: "unicode", char: "🙌" });
	});

	it("prefers workspace custom emoji over built-in unicode", () => {
		const merged: Record<string, SlackEmoji> = {
			...emojiTable(),
			joy: {
				kind: "image",
				url: "https://emoji/joy.png",
				name: "joy",
			},
		};
		expect(resolveEmoji("joy", merged)).toEqual({
			kind: "image",
			url: "https://emoji/joy.png",
			name: "joy",
		});
	});

	it("returns null for unknown shortcodes", () => {
		expect(resolveEmoji("does_not_exist", emojiTable())).toBeNull();
	});
});
