import type { ReactNode } from "react";
import { PaneShell } from "./pane-shell";
import { usePanes } from "./provider";
import type { Pane } from "./types";

type PanesLayout = "1x1" | "1x2" | "2x1" | "2x2";

function layoutFor(count: number): PanesLayout {
	// PR 1 only ever has one main-target pane. Future PRs widen this.
	if (count <= 1) return "1x1";
	if (count === 2) return "1x2";
	return "2x2";
}

interface PanesGridProps {
	children: (pane: Pane) => ReactNode;
}

export function PanesGrid({ children }: PanesGridProps) {
	const { panes } = usePanes();
	const mainPanes = panes.filter((pane) => pane.target === "main");
	const layout = layoutFor(mainPanes.length);

	return (
		<div
			data-panes-layout={layout}
			className="grid h-full w-full"
			style={{ gridTemplateColumns: "1fr" }}
		>
			{mainPanes.map((pane) => (
				<PaneShell key={pane.id} pane={pane}>
					{children(pane)}
				</PaneShell>
			))}
		</div>
	);
}
