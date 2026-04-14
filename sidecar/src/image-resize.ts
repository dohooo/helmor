/**
 * Zero-dependency image dimension detection and resizing.
 *
 * Parses PNG / JPEG / GIF headers to read pixel dimensions, then uses
 * platform-native tools (`sips` on macOS, `magick`/`convert` on Linux) to
 * downscale oversized images.  This avoids depending on sharp / libvips
 * native bindings that are unavailable in the Tauri app bundle.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Claude API hard limit — images must fit within this box. */
const MAX_DIMENSION = 2000;

interface ImageDimensions {
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------
// Header parsing — pure TypeScript, no native deps
// ---------------------------------------------------------------------------

function parseDimensions(buf: Buffer): ImageDimensions | null {
	if (buf.length < 10) return null;

	// PNG: 8-byte signature (\x89PNG\r\n\x1a\n) + IHDR
	if (
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47 &&
		buf.length >= 24
	) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}

	// JPEG: SOI (0xFFD8), then scan for SOF markers
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < buf.length) {
			if (buf[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = buf[offset + 1]!;
			// SOF0–SOF15 (0xC0–0xCF), excluding DHT (0xC4) and JPG ext (0xC8)
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8
			) {
				return {
					height: buf.readUInt16BE(offset + 5),
					width: buf.readUInt16BE(offset + 7),
				};
			}
			if (offset + 3 >= buf.length) break;
			offset += 2 + buf.readUInt16BE(offset + 2);
		}
	}

	// GIF: "GIF87a" / "GIF89a"
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Platform-native resize
// ---------------------------------------------------------------------------

async function resizeWithSips(input: string, output: string): Promise<boolean> {
	try {
		await execFileAsync("sips", [
			"--resampleHeightWidthMax",
			String(MAX_DIMENSION),
			input,
			"--out",
			output,
		]);
		return true;
	} catch {
		return false;
	}
}

async function resizeWithConvert(
	input: string,
	output: string,
): Promise<boolean> {
	for (const cmd of ["magick", "convert"]) {
		try {
			await execFileAsync(cmd, [
				input,
				"-resize",
				`${MAX_DIMENSION}x${MAX_DIMENSION}>`,
				output,
			]);
			return true;
		} catch {}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResizedImage {
	/** Image data (original if within limits, resized otherwise). */
	buffer: Buffer;
	/** Whether the image was actually resized. */
	resized: boolean;
}

/**
 * Read an image from disk and, if either dimension exceeds `MAX_DIMENSION`,
 * downscale it using platform-native tools.  Returns the (possibly resized)
 * image buffer ready for base64 encoding.
 */
export async function readImageWithResize(
	filePath: string,
): Promise<ResizedImage> {
	const original = await readFile(filePath);
	const dims = parseDimensions(original);

	if (!dims) {
		// Unrecognized format — pass through unchanged.
		return { buffer: original, resized: false };
	}

	if (dims.width <= MAX_DIMENSION && dims.height <= MAX_DIMENSION) {
		return { buffer: original, resized: false };
	}

	logger.info("Image exceeds 2000px limit, resizing before SDK handoff", {
		path: filePath,
		width: dims.width,
		height: dims.height,
	});

	const ext = extname(filePath) || ".png";
	const tmpDir = await mkdtemp(join(tmpdir(), "helmor-img-"));
	const tmpPath = join(tmpDir, `resized${ext}`);

	const ok =
		process.platform === "darwin"
			? await resizeWithSips(filePath, tmpPath)
			: await resizeWithConvert(filePath, tmpPath);

	if (!ok) {
		logger.error("Resize failed, forwarding original image", {
			path: filePath,
		});
		return { buffer: original, resized: false };
	}

	try {
		const resized = await readFile(tmpPath);
		logger.info("Image resized successfully", {
			path: filePath,
			originalBytes: original.length,
			resizedBytes: resized.length,
		});
		return { buffer: resized, resized: true };
	} finally {
		unlink(tmpPath).catch(() => {});
	}
}
