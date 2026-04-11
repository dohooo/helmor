import { describe, expect, it } from "vitest";
import type { InspectorFileItem } from "@/lib/editor-session";
import {
	filterFiles,
	MAX_VISIBLE_OPTIONS,
	rankFile,
} from "./file-mention-plugin";

function file(path: string): InspectorFileItem {
	const name = path.split("/").pop() ?? path;
	return {
		path,
		absolutePath: `/abs/${path}`,
		name,
		status: "M",
		insertions: 0,
		deletions: 0,
	};
}

describe("rankFile", () => {
	it("scores filename prefix matches highest", () => {
		const f = file("src/components/Button.tsx");
		expect(rankFile(f, "but")).toBe(3);
		expect(rankFile(f, "But")).toBe(3); // case-insensitive
	});

	it("scores filename substring above path-only matches", () => {
		const f = file("src/widgets/MyButton.tsx");
		expect(rankFile(f, "button")).toBe(2);
	});

	it("scores path-only substring matches lowest", () => {
		const f = file("src/widgets/Header.tsx");
		expect(rankFile(f, "widgets")).toBe(1);
	});

	it("returns 0 when nothing matches", () => {
		const f = file("src/Button.tsx");
		expect(rankFile(f, "zzz")).toBe(0);
	});

	it("treats empty query as a match", () => {
		const f = file("any.ts");
		expect(rankFile(f, "")).toBe(1);
	});
});

describe("filterFiles", () => {
	const files = [
		file("src/buttons/Header.tsx"), // path-only match for "but"
		file("src/MyButton.tsx"), // filename substring match
		file("src/Button.tsx"), // filename prefix match
		file("README.md"), // no match
	];

	it("ranks prefix > substring > path-only", () => {
		const result = filterFiles(files, "but");
		expect(result.map((f) => f.name)).toEqual([
			"Button.tsx", // prefix (rank 3)
			"MyButton.tsx", // filename substring (rank 2)
			"Header.tsx", // path-only (rank 1)
		]);
	});

	it("filters out files that do not match anywhere", () => {
		// "but" appears nowhere in README.md or its path.
		const result = filterFiles(files, "but");
		expect(result.find((f) => f.name === "README.md")).toBeUndefined();
	});

	it("includes path-only matches when query hits the directory", () => {
		const result = filterFiles(files, "buttons");
		expect(result.map((f) => f.name)).toContain("Header.tsx");
	});

	it("returns the first MAX_VISIBLE_OPTIONS items when the query is empty", () => {
		const many = Array.from({ length: MAX_VISIBLE_OPTIONS + 25 }, (_, i) =>
			file(`src/file_${String(i).padStart(3, "0")}.ts`),
		);
		const result = filterFiles(many, "");
		expect(result).toHaveLength(MAX_VISIBLE_OPTIONS);
		// Order is preserved (no re-sort for empty query).
		expect(result[0]?.name).toBe("file_000.ts");
		expect(result[result.length - 1]?.name).toBe(
			`file_${String(MAX_VISIBLE_OPTIONS - 1).padStart(3, "0")}.ts`,
		);
	});

	it("caps a large filtered set at MAX_VISIBLE_OPTIONS", () => {
		const many = Array.from({ length: MAX_VISIBLE_OPTIONS + 25 }, (_, i) =>
			file(`src/widget_${i}.tsx`),
		);
		const result = filterFiles(many, "widget");
		expect(result.length).toBeLessThanOrEqual(MAX_VISIBLE_OPTIONS);
	});

	it("preserves upstream order within the same rank bucket", () => {
		// Two prefix matches — should appear in input order.
		const ordered = [
			file("src/Apple.tsx"),
			file("src/Apricot.tsx"),
			file("src/Banana.tsx"),
		];
		const result = filterFiles(ordered, "ap");
		expect(result.map((f) => f.name)).toEqual(["Apple.tsx", "Apricot.tsx"]);
	});
});
