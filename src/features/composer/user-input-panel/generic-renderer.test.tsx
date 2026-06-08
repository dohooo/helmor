import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalCard } from "./generic-renderer";

afterEach(cleanup);

describe("ToolApprovalCard", () => {
	it("renders the description as the body when toolInput is empty (OpenCode read/skill/todo/shell)", () => {
		render(
			<ToolApprovalCard
				toolName="read"
				toolInput={{}}
				description="src/index.ts"
				onResponse={vi.fn()}
			/>,
		);
		// Light + dark code blocks both carry the text, so use getAllByText.
		expect(screen.getAllByText("src/index.ts").length).toBeGreaterThan(0);
		// The empty-object `{}` must NOT be shown.
		expect(screen.queryByText("{}")).toBeNull();
	});

	it("falls back to JSON when toolInput is empty and no description", () => {
		render(
			<ToolApprovalCard toolName="todo" toolInput={{}} onResponse={vi.fn()} />,
		);
		expect(screen.getAllByText("{}").length).toBeGreaterThan(0);
	});

	it("renders the bash command for shell-like tools", () => {
		render(
			<ToolApprovalCard
				toolName="bash"
				toolInput={{ command: "ls -la" }}
				onResponse={vi.fn()}
			/>,
		);
		expect(screen.getAllByText("ls -la").length).toBeGreaterThan(0);
	});

	it("renders the JSON input when toolInput has keys (ignores description fallback)", () => {
		render(
			<ToolApprovalCard
				toolName="edit"
				toolInput={{ filepath: "a.ts" }}
				description="a.ts"
				onResponse={vi.fn()}
			/>,
		);
		// JSON form keeps the quoted key, distinct from the plain fallback.
		expect(screen.getAllByText(/"filepath"/).length).toBeGreaterThan(0);
	});
});
