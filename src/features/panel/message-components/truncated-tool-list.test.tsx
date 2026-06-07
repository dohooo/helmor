import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TruncatedToolList } from "./truncated-tool-list";

afterEach(() => cleanup());

const getKey = (item: string) => item;
const renderItem = (item: string) => <div>{item}</div>;

describe("TruncatedToolList", () => {
	it("renders all items and no toggle at or below the preview cap", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c"]}
				getKey={getKey}
				renderItem={renderItem}
			/>,
		);
		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.getByText("b")).toBeInTheDocument();
		expect(screen.getByText("c")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows only the last previewCount items with a toggle when over the cap", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c", "d", "e"]}
				getKey={getKey}
				renderItem={renderItem}
			/>,
		);
		expect(screen.queryByText("a")).not.toBeInTheDocument();
		expect(screen.queryByText("b")).not.toBeInTheDocument();
		expect(screen.getByText("c")).toBeInTheDocument();
		expect(screen.getByText("d")).toBeInTheDocument();
		expect(screen.getByText("e")).toBeInTheDocument();
		expect(screen.getByRole("button")).toHaveTextContent(/Show 2 more steps$/);
	});

	it("toggles between collapsed and expanded", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c", "d", "e"]}
				getKey={getKey}
				renderItem={renderItem}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("a")).toBeInTheDocument();
		expect(screen.getByText("e")).toBeInTheDocument();
		expect(screen.getByRole("button")).toHaveTextContent("Collapse");

		fireEvent.click(screen.getByRole("button"));
		expect(screen.queryByText("a")).not.toBeInTheDocument();
		expect(screen.getByRole("button")).toHaveTextContent(/Show 2 more steps$/);
	});

	it("uses the singular noun for a single hidden item", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c", "d"]}
				getKey={getKey}
				renderItem={renderItem}
			/>,
		);
		expect(screen.getByRole("button")).toHaveTextContent(/Show 1 more step$/);
	});

	it("counts only filtered items toward the cap but expands to all", () => {
		const items = [
			{ id: "tool-1", kind: "tool" },
			{ id: "text-1", kind: "text" },
			{ id: "tool-2", kind: "tool" },
			{ id: "tool-3", kind: "tool" },
			{ id: "tool-4", kind: "tool" },
		];
		render(
			<TruncatedToolList
				items={items}
				getKey={(i) => i.id}
				previewFilter={(i) => i.kind === "tool"}
				renderItem={(i) => <div>{i.id}</div>}
			/>,
		);
		// Collapsed: last 3 of the 4 tool items; text + first tool hidden.
		expect(screen.queryByText("text-1")).not.toBeInTheDocument();
		expect(screen.queryByText("tool-1")).not.toBeInTheDocument();
		expect(screen.getByText("tool-2")).toBeInTheDocument();
		expect(screen.getByText("tool-3")).toBeInTheDocument();
		expect(screen.getByText("tool-4")).toBeInTheDocument();
		// hiddenCount = 5 total - min(4 tools, 3) = 2
		expect(screen.getByRole("button")).toHaveTextContent(/Show 2 more steps$/);

		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("text-1")).toBeInTheDocument();
		expect(screen.getByText("tool-1")).toBeInTheDocument();
	});

	it("respects a custom previewCount and passes expanded to renderItem", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c"]}
				previewCount={1}
				getKey={getKey}
				renderItem={(item, { expanded }) => (
					<div>{expanded ? `${item}-expanded` : item}</div>
				)}
			/>,
		);
		expect(screen.getByText("c")).toBeInTheDocument();
		expect(screen.queryByText("a")).not.toBeInTheDocument();
		expect(screen.getByRole("button")).toHaveTextContent(/Show 2 more steps$/);

		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("a-expanded")).toBeInTheDocument();
		expect(screen.getByText("c-expanded")).toBeInTheDocument();
	});

	it("uses a custom plural noun in the toggle label", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c", "d", "e"]}
				getKey={getKey}
				renderItem={renderItem}
				noun={{ one: "command", other: "commands" }}
			/>,
		);
		expect(screen.getByRole("button")).toHaveTextContent(
			/Show 2 more commands$/,
		);
	});

	it("uses the custom singular noun for a single hidden item", () => {
		render(
			<TruncatedToolList
				items={["a", "b", "c", "d"]}
				getKey={getKey}
				renderItem={renderItem}
				noun={{ one: "command", other: "commands" }}
			/>,
		);
		expect(screen.getByRole("button")).toHaveTextContent(
			/Show 1 more command$/,
		);
	});
});
