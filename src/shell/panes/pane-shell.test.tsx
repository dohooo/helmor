// src/shell/panes/pane-shell.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePaneIdentity } from "./identity-context";
import { PaneShell } from "./pane-shell";
import type { Pane } from "./types";

function IdentityProbe() {
	const id = usePaneIdentity();
	return (
		<div data-testid="probe">
			{id.paneId}/{id.workspaceId ?? "null"}/{id.sessionId ?? "null"}
		</div>
	);
}

describe("PaneShell", () => {
	afterEach(() => {
		cleanup();
	});

	it("injects the pane's identity into context", () => {
		const pane: Pane = {
			id: "p1",
			workspaceId: "ws-a",
			sessionId: "s-x",
			target: "main",
		};
		render(
			<PaneShell pane={pane}>
				<IdentityProbe />
			</PaneShell>,
		);
		expect(screen.getByTestId("probe").textContent).toBe("p1/ws-a/s-x");
	});

	it("handles null workspace/session", () => {
		const pane: Pane = {
			id: "p1",
			workspaceId: null,
			sessionId: null,
			target: "main",
		};
		render(
			<PaneShell pane={pane}>
				<IdentityProbe />
			</PaneShell>,
		);
		expect(screen.getByTestId("probe").textContent).toBe("p1/null/null");
	});
});
