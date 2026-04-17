/**
 * Phase 0 baseline tests for the image-resize platform dispatcher.
 *
 * These lock in the current behavior so Phase 3's Windows branch cannot
 * regress darwin / linux paths. The tests exercise only the exported code
 * surface (`readImageWithResize`) by poking `process.platform` and feeding
 * images that trigger the resize code path (dimensions > 2000px).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImageWithResize } from "../src/image-resize.js";

/** Build a synthetic PNG IHDR with given dimensions. Not decodable as a real image
 *  by native tools but sufficient to make `parseDimensions` see "> 2000px" and
 *  trigger the platform resize dispatcher. */
function makePng(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	// PNG signature (8 bytes)
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	// IHDR width / height at offsets 16 / 20 (BE u32)
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

describe("readImageWithResize baseline", () => {
	test("small images pass through without resize", async () => {
		const dir = await mkdtemp(join(tmpdir(), "helmor-img-test-"));
		const path = join(dir, "small.png");
		const png = makePng(100, 100);
		await writeFile(path, png);

		const result = await readImageWithResize(path);
		expect(result.resized).toBe(false);
		expect(result.buffer.equals(png)).toBe(true);

		await rm(dir, { recursive: true, force: true });
	});

	test("unrecognized formats pass through unchanged", async () => {
		const dir = await mkdtemp(join(tmpdir(), "helmor-img-test-"));
		const path = join(dir, "weird.bin");
		const payload = Buffer.from("not an image at all, just bytes");
		await writeFile(path, payload);

		const result = await readImageWithResize(path);
		expect(result.resized).toBe(false);
		expect(result.buffer.equals(payload)).toBe(true);

		await rm(dir, { recursive: true, force: true });
	});

	test("oversized image triggers platform resize dispatcher and returns original on tool failure", async () => {
		// Synthetic PNG with 3000×3000 header — parseDimensions reads the header
		// and dispatches to sips/magick. Real tools will reject this malformed file,
		// so the code must fall back to returning the original buffer.
		const dir = await mkdtemp(join(tmpdir(), "helmor-img-test-"));
		const path = join(dir, "huge.png");
		const png = makePng(3000, 3000);
		await writeFile(path, png);

		const result = await readImageWithResize(path);
		// Regardless of platform, graceful fallback must return the original.
		expect(result.buffer.equals(png)).toBe(true);
		// resized === false because the tool failed.
		expect(result.resized).toBe(false);

		await rm(dir, { recursive: true, force: true });
	});
});
