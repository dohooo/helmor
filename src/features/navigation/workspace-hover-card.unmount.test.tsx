import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceRow } from "@/lib/api";
import { WORKSPACE_DND_ACTIVE_ATTRIBUTE } from "./dnd/shared";
import { WorkspaceHoverCard } from "./workspace-hover-card";

const row: WorkspaceRow = { id: "ws-hover-unmount", title: "row-title" };

afterEach(() => {
	vi.useRealTimers();
});

// Regression: Radix hover-card's `handleOpen` overwrites its pending
// open-timer ref without clearing it, so a pointerenter→focus sequence (what
// every click on the trigger produces) orphans an open timer that survives
// unmount and fires ~openDelay later. Before the unmount guard in
// `handleOpenChange`, that orphan touched `document` post-unmount — and after
// vitest environment teardown that became an unhandled
// "document is not defined" error failing the whole run (round6 hygiene #1).
it("ignores hover-card open timers that fire after unmount", () => {
	vi.useFakeTimers();
	const { unmount } = render(
		<WorkspaceHoverCard row={row}>
			<button type="button">trigger</button>
		</WorkspaceHoverCard>,
	);
	const trigger = screen.getByRole("button", { name: "trigger" });
	fireEvent.pointerEnter(trigger); // schedules Radix open timer #1
	fireEvent.focus(trigger); // schedules open timer #2, orphaning #1
	unmount(); // Radix unmount cleanup only clears timer #2

	const getAttribute = vi.spyOn(document.documentElement, "getAttribute");
	vi.advanceTimersByTime(1_000); // orphaned timer #1 fires post-unmount
	expect(getAttribute).not.toHaveBeenCalledWith(WORKSPACE_DND_ACTIVE_ATTRIBUTE);
});
