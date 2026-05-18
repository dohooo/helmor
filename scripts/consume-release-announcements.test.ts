import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeReleaseAnnouncements } from "./consume-release-announcements";

type CatalogFile = {
	items: Array<{
		releaseVersion: string;
		items: Array<{ text: string }>;
	}>;
};

let repoRoot: string;

async function writeJson(path: string, value: unknown) {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function readCatalog(): Promise<CatalogFile> {
	return JSON.parse(
		await readFile(
			join(
				repoRoot,
				"src/features/announcements/release-announcement-catalog.json",
			),
			"utf8",
		),
	) as CatalogFile;
}

async function createRepo(options?: {
	version?: string;
	catalog?: CatalogFile;
}) {
	await writeJson(join(repoRoot, "package.json"), {
		version: options?.version ?? "1.2.3",
	});
	await mkdir(join(repoRoot, ".announcements"), { recursive: true });
	await mkdir(join(repoRoot, "src/features/announcements"), {
		recursive: true,
	});
	await writeJson(
		join(
			repoRoot,
			"src/features/announcements/release-announcement-catalog.json",
		),
		options?.catalog ?? { items: [] },
	);
}

describe("consumeReleaseAnnouncements", () => {
	beforeEach(async () => {
		repoRoot = await mkdtemp(join(tmpdir(), "helmor-announcements-"));
	});

	afterEach(async () => {
		await rm(repoRoot, { recursive: true, force: true });
	});

	it("merges multiple pending fragments into one entry for the package version", async () => {
		await createRepo();
		await writeJson(join(repoRoot, ".announcements/b-context.json"), {
			items: [{ text: "Context" }],
		});
		await writeJson(join(repoRoot, ".announcements/a-sidebar.json"), {
			items: [{ text: "Sidebar" }],
		});

		const result = consumeReleaseAnnouncements(repoRoot);

		expect(result).toEqual({
			version: "1.2.3",
			consumedFiles: ["a-sidebar.json", "b-context.json"],
			consumedItems: 2,
		});
		await expect(readdir(join(repoRoot, ".announcements"))).resolves.toEqual(
			[],
		);
		await expect(readCatalog()).resolves.toEqual({
			items: [
				{
					releaseVersion: "1.2.3",
					items: [{ text: "Sidebar" }, { text: "Context" }],
				},
			],
		});
	});

	it("appends pending items to an existing entry for the same version", async () => {
		await createRepo({
			version: "1.2.3",
			catalog: {
				items: [
					{ releaseVersion: "1.2.3", items: [{ text: "Existing" }] },
					{ releaseVersion: "1.2.2", items: [{ text: "Older" }] },
				],
			},
		});
		await writeJson(join(repoRoot, ".announcements/new.json"), {
			items: [{ text: "New" }],
		});

		consumeReleaseAnnouncements(repoRoot);

		await expect(readCatalog()).resolves.toEqual({
			items: [
				{
					releaseVersion: "1.2.3",
					items: [{ text: "Existing" }, { text: "New" }],
				},
				{ releaseVersion: "1.2.2", items: [{ text: "Older" }] },
			],
		});
	});

	it("does nothing when there are no pending fragments", async () => {
		await createRepo({
			catalog: {
				items: [{ releaseVersion: "1.2.2", items: [{ text: "Older" }] }],
			},
		});

		const result = consumeReleaseAnnouncements(repoRoot);

		expect(result).toEqual({
			version: "1.2.3",
			consumedFiles: [],
			consumedItems: 0,
		});
		await expect(readCatalog()).resolves.toEqual({
			items: [{ releaseVersion: "1.2.2", items: [{ text: "Older" }] }],
		});
	});

	it("rejects pending fragments that include id or releaseVersion", async () => {
		await createRepo();
		await writeJson(join(repoRoot, ".announcements/bad.json"), {
			id: "bad",
			releaseVersion: "1.2.3",
			items: [{ text: "Bad" }],
		});

		expect(() => consumeReleaseAnnouncements(repoRoot)).toThrow(
			"must not include id or releaseVersion",
		);
		await expect(readCatalog()).resolves.toEqual({ items: [] });
		await expect(readdir(join(repoRoot, ".announcements"))).resolves.toEqual([
			"bad.json",
		]);
	});
});
