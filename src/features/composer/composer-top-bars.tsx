import { Fragment, type ReactNode } from "react";

/**
 * # Composer-top bars — the two families and their stacking contract
 *
 * Everything that renders above the composer belongs to exactly one of two
 * visual families. When you add a new bar, pick a family and follow its
 * rules — do not invent a third style.
 *
 * ## 1. Card bars (freestanding)
 *
 * `TaskProgressPanel` (./task-progress) and `WorkflowProgressPanel`
 * (./workflow-progress-panel). Self-contained flat cards: closed border on
 * all four sides, `rounded-lg border-border/70 dark:border-border/40
 * bg-background`, no shadow, own vertical margins. They never visually
 * attach to the composer and need no coordination — stack freely.
 *
 * ## 2. Docked bars (open-bottom)
 *
 * `CodexGoalBanner` and `SubmitQueueList`. Designed to look like an
 * extension of the composer: open bottom edge (`rounded-t-2xl border-b-0`)
 * that "plugs into" the composer's top border.
 *
 * **The docking rule:** only the bar that actually sits directly on the
 * composer (the bottom-most visible docked bar) may keep its open bottom.
 * Any docked bar rendered above another visible docked bar must close its
 * bottom edge and become a detached pill/card — an open bottom hanging in
 * mid-air over another bar reads broken.
 *
 * `DockedBarStack` centralises this: register the bars in top-to-bottom
 * order with their visibility, and it passes each one `docked` — true only
 * for the last visible entry. Every docked-family component must accept a
 * `docked` prop and render its closed-bottom variant when false.
 */
/**
 * Card-family chrome. Every card bar spreads this as its root class so the
 * flat look (uniform radius, composer-matched border/background, no shadow)
 * stays in one place. Add layout-specific bits (margins, padding) at the
 * call site with `cn(CARD_BAR_CHROME, ...)`.
 */
export const CARD_BAR_CHROME =
	"pointer-events-auto flex w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-background outline-none dark:border-border/40";

export type DockedBar = {
	key: string;
	/** The stack needs visibility up front (a component that returns null
	 *  can't be probed), so hosts must lift the "will this render?" check. */
	visible: boolean;
	render: (docked: boolean) => ReactNode;
};

export function DockedBarStack({ bars }: { bars: readonly DockedBar[] }) {
	const lastVisible = bars.reduce(
		(last, bar, index) => (bar.visible ? index : last),
		-1,
	);
	return (
		<>
			{bars.map((bar, index) =>
				bar.visible ? (
					<Fragment key={bar.key}>{bar.render(index === lastVisible)}</Fragment>
				) : null,
			)}
		</>
	);
}
