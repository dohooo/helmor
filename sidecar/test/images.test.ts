import { describe, expect, test } from "bun:test";
import { parseImageRefs } from "../src/images.js";

describe("parseImageRefs", () => {
	test("plain prompt with no images returns text unchanged", () => {
		const result = parseImageRefs("what does this code do?");
		expect(result.text).toBe("what does this code do?");
		expect(result.imagePaths).toEqual([]);
	});

	test("extracts a single png reference", () => {
		const result = parseImageRefs("look at @/tmp/screenshot.png please");
		expect(result.imagePaths).toEqual(["/tmp/screenshot.png"]);
		expect(result.text).toBe("look at please");
	});

	test("extracts multiple images of different extensions", () => {
		const result = parseImageRefs(
			"compare @/a/one.png with @/b/two.jpg and @/c/three.gif",
		);
		expect(result.imagePaths).toEqual([
			"/a/one.png",
			"/b/two.jpg",
			"/c/three.gif",
		]);
		expect(result.text).toBe("compare with and");
	});

	test("deduplicates repeated paths", () => {
		const result = parseImageRefs(
			"first @/tmp/a.png then again @/tmp/a.png later",
		);
		expect(result.imagePaths).toEqual(["/tmp/a.png"]);
	});

	test("supports jpeg, webp, svg, bmp, ico", () => {
		const prompt = "@/x/a.jpeg @/x/b.webp @/x/c.svg @/x/d.bmp @/x/e.ico";
		const result = parseImageRefs(prompt);
		expect(result.imagePaths).toEqual([
			"/x/a.jpeg",
			"/x/b.webp",
			"/x/c.svg",
			"/x/d.bmp",
			"/x/e.ico",
		]);
	});

	test("is case-insensitive on extension", () => {
		const result = parseImageRefs("@/tmp/file.PNG");
		expect(result.imagePaths).toEqual(["/tmp/file.PNG"]);
	});

	test("ignores files with unsupported extensions", () => {
		const result = parseImageRefs("check @/tmp/notes.txt and @/tmp/video.mp4");
		expect(result.imagePaths).toEqual([]);
		expect(result.text).toBe("check @/tmp/notes.txt and @/tmp/video.mp4");
	});

	test("collapses leftover multi-spaces after stripping refs", () => {
		const result = parseImageRefs("start   @/a/img.png   end");
		expect(result.text).toBe("start end");
	});

	test("trims leading/trailing whitespace from result text", () => {
		const result = parseImageRefs("  @/a/img.png  ");
		expect(result.text).toBe("");
	});
});
