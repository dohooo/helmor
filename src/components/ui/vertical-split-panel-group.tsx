import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type VerticalSplitPanelGroupPanel = {
	id: string;
	open: boolean;
	resizable?: boolean;
	node: ReactNode;
};

type VerticalSplitPanelGroupProps = {
	panels: VerticalSplitPanelGroupPanel[];
	renderResizeHandle: (panelId: string) => ReactNode;
	className?: string;
};

export const VerticalSplitPanelGroup = forwardRef<
	HTMLDivElement,
	VerticalSplitPanelGroupProps
>(function VerticalSplitPanelGroup(
	{ panels, renderResizeHandle, className },
	ref,
) {
	return (
		<div ref={ref} className={cn("flex h-full min-h-0 flex-col", className)}>
			{panels.map((panel) => (
				<PanelSlot
					key={panel.id}
					panel={panel}
					renderResizeHandle={renderResizeHandle}
				/>
			))}
		</div>
	);
});

function PanelSlot({
	panel,
	renderResizeHandle,
}: {
	panel: VerticalSplitPanelGroupPanel;
	renderResizeHandle: (panelId: string) => ReactNode;
}) {
	return (
		<>
			{panel.open && panel.resizable ? renderResizeHandle(panel.id) : null}
			{panel.node}
		</>
	);
}
