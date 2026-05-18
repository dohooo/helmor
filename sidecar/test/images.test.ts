import { describe, expect, test } from "bun:test";
import { parseImageRefs } from "../src/images.js";

describe("parseImageRefs", () => {
	test("plain prompt with no images returns trimmed text and empty paths", () => {
		const result = parseImageRefs("what does this code do?", []);
		expect(result.text).toBe("what does this code do?");
		expect(result.imagePaths).toEqual([]);
	});

	test("an empty array preserves `@<path>` text verbatim (no regex fallback)", () => {
		const result = parseImageRefs("look at @/tmp/file.png", []);
		expect(result.imagePaths).toEqual([]);
		expect(result.text).toBe("look at @/tmp/file.png");
	});

	test("strips a single image path containing spaces", () => {
		const path =
			"/Users/me/Library/Application Support/CleanShot/CleanShot 2026-04-29 at 08.24.35@2x.jpg";
		const result = parseImageRefs(`Clicking on @${path} now`, [path]);
		expect(result.imagePaths).toEqual([path]);
		expect(result.text).toBe("Clicking on now");
	});

	test("dedupes structured paths", () => {
		const path = "/abs path/shot.png";
		const result = parseImageRefs(`@${path} again @${path}`, [path, path]);
		expect(result.imagePaths).toEqual([path]);
		expect(result.text).toBe("again");
	});

	test("only listed paths are extracted; other `@<path>` text is preserved", () => {
		const path = "/abs path/shot.png";
		const result = parseImageRefs(`old @/tmp/file.png and new @${path}`, [
			path,
		]);
		expect(result.imagePaths).toEqual([path]);
		expect(result.text).toBe("old @/tmp/file.png and new");
	});

	test("longer paths win on overlap (suffix path doesn't shadow)", () => {
		const longer = "/abs/dir with space/screenshot.png";
		const shorter = "/screenshot.png";
		const result = parseImageRefs(`look @${longer} please`, [shorter, longer]);
		expect(result.imagePaths).toEqual([shorter, longer]);
		// The longer needle absorbs the substring; nothing strips the
		// stand-alone `/screenshot.png` (it never appeared in the text).
		expect(result.text).toBe("look please");
	});

	test("strips multiple distinct image paths", () => {
		const a = "/a/one.png";
		const b = "/b/two.jpg";
		const result = parseImageRefs(`compare @${a} with @${b}`, [a, b]);
		expect(result.imagePaths).toEqual([a, b]);
		expect(result.text).toBe("compare with");
	});

	test("collapses leftover multi-spaces after stripping refs", () => {
		const path = "/a/img.png";
		const result = parseImageRefs(`start   @${path}   end`, [path]);
		expect(result.text).toBe("start end");
	});

	test("trims leading/trailing whitespace from result text", () => {
		const path = "/a/img.png";
		const result = parseImageRefs(`  @${path}  `, [path]);
		expect(result.text).toBe("");
	});
});
