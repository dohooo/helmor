import { useLayoutEffect, useRef, useState } from "react";
import { MockConversation } from "./conversation";
import { MockInspector } from "./inspector";
import { MockSidebar } from "./sidebar";

/**
 * Logical size of the mockup viewport. Chosen to match a typical real Helmor
 * window (≈1300×900) so all `.ui.tsx` primitives lay out exactly as they
 * would in production — same flex distribution, same text wrapping, same
 * `min-width` / `max-w-[75%]` outcomes. We then visually shrink the result
 * to whatever space the onboarding card has via `transform: scale`.
 */
const MOCKUP_LOGICAL_WIDTH = 1300;
const MOCKUP_LOGICAL_HEIGHT = 900;
const MOCKUP_SIDEBAR_WIDTH = 240;
const MOCKUP_INSPECTOR_WIDTH = 280;

export function HelmorOnboardingMockup({
	interactive = false,
	providerSpotlight = false,
	gitHeaderSpotlight = false,
	cliSplitSpotlight = false,
}: {
	/**
	 * When false (default), interactive affordances inside the mockup
	 * (e.g. the sidebar's "add repository" dropdown) are disabled so the
	 * mockup behaves as a still preview. The onboarding flow flips this on
	 * during later steps where the mockup acts as a backdrop and small
	 * interactions ("look, you can open this") add narrative polish.
	 */
	interactive?: boolean;
	providerSpotlight?: boolean;
	gitHeaderSpotlight?: boolean;
	cliSplitSpotlight?: boolean;
} = {}) {
	const spotlightActive =
		providerSpotlight || gitHeaderSpotlight || cliSplitSpotlight;
	const containerRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(0.5);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const update = () => {
			const next = el.clientWidth / MOCKUP_LOGICAL_WIDTH;
			if (next > 0) setScale(next);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={containerRef}
			aria-label="Helmor workspace preview"
			className={`aspect-[1300/900] w-full overflow-hidden text-foreground transition-colors duration-1000 ${
				spotlightActive ? "bg-black/42" : "bg-background"
			}`}
		>
			<div
				className="relative flex min-h-0 origin-top-left bg-background"
				style={{
					width: `${MOCKUP_LOGICAL_WIDTH}px`,
					height: `${MOCKUP_LOGICAL_HEIGHT}px`,
					transform: `scale(${scale})`,
				}}
			>
				<div
					className="flex h-full shrink-0 bg-sidebar"
					style={{ width: `${MOCKUP_SIDEBAR_WIDTH}px` }}
				>
					<MockSidebar
						interactive={interactive}
						cliSplitSpotlight={cliSplitSpotlight}
					/>
				</div>
				<div className="w-px shrink-0 bg-border" />
				<MockConversation
					providerSpotlight={providerSpotlight}
					cliSplitSpotlight={cliSplitSpotlight}
				/>
				<div className="w-px shrink-0 bg-border" />
				<div
					className="flex h-full shrink-0"
					style={{ width: `${MOCKUP_INSPECTOR_WIDTH}px` }}
				>
					<MockInspector gitHeaderSpotlight={gitHeaderSpotlight} />
				</div>
				<div
					aria-hidden
					className={`pointer-events-none absolute -inset-2 z-20 transition-colors duration-[600ms] ${
						spotlightActive ? "bg-black/55" : "bg-transparent"
					}`}
				/>
			</div>
		</div>
	);
}
