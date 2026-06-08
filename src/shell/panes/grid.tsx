import type { ReactNode } from "react";
import { PaneShell } from "./pane-shell";
import { usePanes } from "./provider";
import type { Pane } from "./types";

interface PanesGridProps {
	children: (pane: Pane) => ReactNode;
}

export function PanesGrid({ children }: PanesGridProps) {
	const { panes } = usePanes();
	const mainPanes = panes.filter((pane) => pane.target === "main");

	return (
		<div data-panes-layout="1x1" style={{ display: "contents" }}>
			{mainPanes.map((pane) => (
				<PaneShell key={pane.id} pane={pane}>
					{children(pane)}
				</PaneShell>
			))}
		</div>
	);
}
