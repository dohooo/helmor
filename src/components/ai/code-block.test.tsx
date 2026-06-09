import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { codeToHtml } from "shiki";
import { afterEach, describe, expect, it } from "vitest";
import { CodeBlock, CodeBlockCopyButton } from "./code-block";

afterEach(() => {
	cleanup();
});

describe("CodeBlock", () => {
	it("uses floating actions when no language is provided", () => {
		const { container } = render(
			<CodeBlock code="mutation kept pending → timed out after 32.5s, 10 calls total">
				<CodeBlockCopyButton />
			</CodeBlock>,
		);

		expect(
			container.querySelector('[data-code-block-actions="header"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-code-block-actions="floating"]'),
		).not.toBeNull();
		expect(screen.getByRole("button")).toBeInTheDocument();
	});

	it("keeps header actions when a language is provided", () => {
		const { container } = render(
			<CodeBlock code="const value = 1;" language="ts">
				<CodeBlockCopyButton />
			</CodeBlock>,
		);

		expect(
			container.querySelector('[data-code-block-actions="header"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-code-block-actions="floating"]'),
		).toBeNull();
	});

	// Highlighting is deferred to requestIdleCallback (setTimeout fallback),
	// so the very first synchronous render still shows the escaped plain-text
	// fallback. This locks the "fallback stays visible until the highlight
	// resolves" contract of the deferral.
	it("renders the plain-text fallback synchronously before the deferred highlight", () => {
		const code = "const value = 1 < 2;";
		const { container } = render(<CodeBlock code={code} language="ts" />);

		const lightPane = container.querySelector("div.dark\\:hidden");
		// Escaped plain text, no shiki tokenization yet.
		expect(lightPane?.innerHTML).toBe(
			"<pre><code>const value = 1 &lt; 2;</code></pre>",
		);
		expect(lightPane?.innerHTML).not.toContain("shiki");
	});

	// Zero-functional-change guarantee for the idle-defer optimization: the
	// HTML that eventually lands must be byte-identical to running shiki
	// eagerly (only the timing changed). We compare both the light and dark
	// panes against direct `codeToHtml` output with the same arguments.
	it("converges to byte-identical shiki HTML after the deferred highlight", async () => {
		const code = "const value = 1;\nfunction f() { return value; }";
		const [expectedLight, expectedDark] = await Promise.all([
			codeToHtml(code, {
				lang: "ts",
				theme: "one-light",
				transformers: [],
			}),
			codeToHtml(code, {
				lang: "ts",
				theme: "one-dark-pro",
				transformers: [],
			}),
		]);

		const { container } = render(<CodeBlock code={code} language="ts" />);

		await waitFor(() => {
			const lightPane = container.querySelector("div.dark\\:hidden");
			expect(lightPane?.innerHTML).toContain("shiki");
		});

		const lightPane = container.querySelector("div.dark\\:hidden");
		const darkPane = container.querySelector("div.dark\\:block");
		expect(lightPane?.innerHTML).toBe(expectedLight);
		expect(darkPane?.innerHTML).toBe(expectedDark);
	});

	// The line-numbers transformer path must also converge byte-identically —
	// it's the most complex shiki argument set the deferral wraps.
	it("converges to byte-identical shiki HTML with line numbers", async () => {
		const code = "const a = 1;\nconst b = 2;";
		const lineNumbers = [
			{
				name: "line-numbers",
				line(node: { children: unknown[] }, line: number) {
					node.children.unshift({
						type: "element",
						tagName: "span",
						properties: {
							className: [
								"inline-block",
								"min-w-8",
								"mr-4",
								"select-none",
								"text-right",
								"text-muted-foreground/55",
							],
						},
						children: [{ type: "text", value: String(line) }],
					});
				},
			},
		];
		const expectedLight = await codeToHtml(code, {
			lang: "ts",
			theme: "one-light",
			transformers: lineNumbers,
		});

		const { container } = render(
			<CodeBlock code={code} language="ts" showLineNumbers />,
		);

		await waitFor(() => {
			const lightPane = container.querySelector("div.dark\\:hidden");
			expect(lightPane?.innerHTML).toContain("shiki");
		});

		const lightPane = container.querySelector("div.dark\\:hidden");
		expect(lightPane?.innerHTML).toBe(expectedLight);
	});
});
