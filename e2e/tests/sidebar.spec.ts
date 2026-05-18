import { expect, test } from "../fixtures/app";

// Smoke test for the Playwright + WebKit harness. Proves that:
//   1. The Helmor React shell can boot in a plain browser with mocked IPC
//   2. The workspace sidebar renders with zero backend data
//   3. Collapse / expand round-trip works end-to-end

test.describe("workspace sidebar", () => {
	test("collapses and expands via the panel toggle", async ({ app }) => {
		const sidebar = app.getByRole("complementary", {
			name: "Workspace sidebar",
		});
		const collapseButton = app.getByRole("button", {
			name: "Collapse left sidebar",
		});

		await expect(sidebar).toBeVisible();
		await expect(collapseButton).toBeVisible();

		await collapseButton.click();

		await expect(sidebar).toHaveCount(0);

		const expandButton = app.getByRole("button", {
			name: "Expand left sidebar",
		});
		await expect(expandButton).toBeVisible();

		await expandButton.click();

		await expect(
			app.getByRole("complementary", { name: "Workspace sidebar" }),
		).toBeVisible();
	});
});
