import { ArrowRight, Check, GitBranch } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import conductorLogoSrc from "@/assets/conductor.webp";
import helmorLogoSrc from "@/assets/helmor-logo.png";
import { type ConductorWorkspace, importConductorWorkspaces } from "@/lib/api";
import { NumberTicker } from "./ui/number-ticker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = "revealed" | "importing" | "done";

// ---------------------------------------------------------------------------
// Background — retro dot grid
// ---------------------------------------------------------------------------

function DotGrid() {
	return (
		<div
			className="pointer-events-none absolute inset-0"
			style={{
				backgroundImage: `radial-gradient(circle, color-mix(in oklch, var(--color-foreground) 9%, transparent) 1px, transparent 1px)`,
				backgroundSize: "22px 22px",
				maskImage:
					"radial-gradient(ellipse 90% 80% at 50% 50%, black 30%, transparent 100%)",
				opacity: 0.5,
			}}
		/>
	);
}

// ---------------------------------------------------------------------------
// Conductor icon — real asset
// ---------------------------------------------------------------------------

function ConductorLogo({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) {
	return (
		<img
			src={conductorLogoSrc}
			alt="Conductor"
			className={className}
			style={style}
			draggable={false}
		/>
	);
}

// ---------------------------------------------------------------------------
// Multi-beam
// ---------------------------------------------------------------------------

type BeamEntry = { id: string; d: string; delay: number };
type BeamAnchorElement = HTMLSpanElement;
const BEAM_LEAD_OUT = 18;
type BeamMode = "logo-to-items" | "items-to-logo";

function buildBeamPath(sx: number, sy: number, ex: number, ey: number) {
	const distance = ex - sx;
	const lead = Math.min(BEAM_LEAD_OUT, Math.max(10, distance * 0.14));
	const startLeadX = sx + lead;
	const endLeadX = ex - lead;
	const c1x = sx + distance * 0.42;
	const c2x = sx + distance * 0.58;

	return `M ${sx} ${sy} L ${startLeadX} ${sy} C ${c1x} ${sy}, ${c2x} ${ey}, ${endLeadX} ${ey} L ${ex} ${ey}`;
}

type MultiBeamProps = {
	workspaceRefs: React.RefObject<Map<string, BeamAnchorElement>>;
	logoRef: React.RefObject<BeamAnchorElement | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
	/** true = fully active (dots cycling), false = idle (paths only) */
	active: boolean;
	/** true = retract all beams and fade dots */
	transferring: boolean;
	workspaceIds: string[];
	mode: BeamMode;
};

function MultiBeam({
	workspaceRefs,
	logoRef,
	containerRef,
	active,
	transferring,
	workspaceIds,
	mode,
}: MultiBeamProps) {
	const gradId = useId();
	const [beams, setBeams] = useState<BeamEntry[]>([]);

	useEffect(() => {
		function recalc() {
			const container = containerRef.current;
			const logoEl = logoRef.current;
			if (!container || !logoEl) return;

			const cr = container.getBoundingClientRect();
			const lr = logoEl.getBoundingClientRect();
			const lx = lr.left + lr.width / 2 - cr.left;
			const ly = lr.top + lr.height / 2 - cr.top;

			const newBeams: BeamEntry[] = [];
			workspaceIds.forEach((id, i) => {
				const el = workspaceRefs.current?.get(id);
				if (!el) return;
				const wr = el.getBoundingClientRect();
				const wx = wr.left + wr.width / 2 - cr.left;
				const wy = wr.top + wr.height / 2 - cr.top;
				const sx = mode === "logo-to-items" ? lx : wx;
				const sy = mode === "logo-to-items" ? ly : wy;
				const ex = mode === "logo-to-items" ? wx : lx;
				const ey = mode === "logo-to-items" ? wy : ly;
				if (ex <= sx) return;

				newBeams.push({
					id,
					d: buildBeamPath(sx, sy, ex, ey),
					delay: i * 0.1,
				});
			});
			setBeams(newBeams);
		}

		// Measure after skeleton layout has settled (~300ms min display).
		const tid = setTimeout(() => requestAnimationFrame(recalc), 300);
		const ro = new ResizeObserver(recalc);
		if (containerRef.current) ro.observe(containerRef.current);
		if (logoRef.current) ro.observe(logoRef.current);
		return () => {
			clearTimeout(tid);
			ro.disconnect();
		};
	}, [workspaceIds, workspaceRefs, logoRef, containerRef, mode]);

	if (!beams.length) return null;

	return (
		<>
			{/* SVG layer — paths */}
			<svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
				<defs>
					<linearGradient id={`${gradId}-g`} x1="0%" y1="0%" x2="100%" y2="0%">
						<stop
							offset="0%"
							stopColor="var(--color-foreground)"
							stopOpacity="0"
						/>
						<stop
							offset="50%"
							stopColor="var(--color-foreground)"
							stopOpacity="0.4"
						/>
						<stop
							offset="100%"
							stopColor="var(--color-foreground)"
							stopOpacity="0"
						/>
					</linearGradient>
				</defs>

				{beams.map((beam, i) => (
					<g key={i}>
						{/* Background rail */}
						<motion.path
							d={beam.d}
							fill="none"
							stroke="var(--color-border)"
							strokeWidth="1"
							strokeLinecap="round"
							initial={{ pathLength: 1, pathOffset: 0, opacity: 0.35 }}
							animate={
								transferring
									? { pathOffset: 1, opacity: 0 }
									: { pathLength: 1, pathOffset: 0, opacity: 0.35 }
							}
							transition={
								transferring
									? {
											duration: 0.65,
											delay: beam.delay,
											ease: [0.4, 0, 0.6, 1],
										}
									: { duration: 0 }
							}
						/>
						{/* Gradient highlight — also retracts when transferring */}
						{(active || transferring) && (
							<motion.path
								d={beam.d}
								fill="none"
								stroke={`url(#${gradId}-g)`}
								strokeWidth="1.5"
								strokeLinecap="round"
								initial={{ pathLength: 0, pathOffset: 0, opacity: 0 }}
								animate={
									transferring
										? { pathOffset: 1, opacity: 0 }
										: { pathLength: 1, pathOffset: 0, opacity: 1 }
								}
								transition={
									transferring
										? {
												duration: 0.65,
												delay: beam.delay,
												ease: [0.4, 0, 0.6, 1],
											}
										: {
												pathLength: {
													duration: 1.4,
													delay: beam.delay,
													ease: "easeOut",
												},
												opacity: { duration: 0.5, delay: beam.delay },
											}
								}
							/>
						)}
					</g>
				))}
			</svg>

			{/* HTML layer — travelling dots (offsetPath requires HTML, not SVG) */}
			{(active || transferring) &&
				beams.map((beam, i) => (
					<motion.div
						key={`dot-${i}`}
						className="pointer-events-none absolute left-0 top-0 size-[5px] rounded-full"
						style={{
							background: "var(--color-foreground)",
							offsetPath: `path("${beam.d}")`,
							offsetRotate: "0deg",
						}}
						initial={{ offsetDistance: "0%", opacity: 0, scale: 0 }}
						animate={
							transferring
								? { opacity: 0, scale: 0 }
								: {
										offsetDistance: ["0%", "100%"],
										opacity: [0, 0.85, 0.85, 0],
										scale: [0, 1, 1, 0],
									}
						}
						transition={
							transferring
								? { duration: 0.3, delay: beam.delay }
								: {
										duration: 2.2,
										ease: "linear",
										repeat: Number.POSITIVE_INFINITY,
										delay: beam.delay + 0.8,
									}
						}
					/>
				))}
		</>
	);
}

// ---------------------------------------------------------------------------
// Workspace skeleton row
// ---------------------------------------------------------------------------

function SkeletonRow({
	id,
	setLeftRef,
	setRightRef,
}: {
	id: string;
	setLeftRef?: (id: string, el: BeamAnchorElement | null) => void;
	setRightRef?: (id: string, el: BeamAnchorElement | null) => void;
}) {
	return (
		<div className="relative flex items-center gap-2.5 rounded-lg border border-border/30 bg-sidebar px-3 py-2.5">
			<span
				aria-hidden="true"
				ref={setLeftRef ? (el) => setLeftRef(id, el) : undefined}
				className="pointer-events-none absolute left-0 top-1/2 size-px -translate-x-1/2 -translate-y-1/2"
			/>
			<span
				aria-hidden="true"
				ref={setRightRef ? (el) => setRightRef(id, el) : undefined}
				className="pointer-events-none absolute right-0 top-1/2 size-px -translate-y-1/2 translate-x-1/2"
			/>
			<div className="size-7 shrink-0 animate-pulse rounded-md bg-muted" />
			<div className="flex-1 space-y-1.5">
				<div className="h-2.5 w-28 animate-pulse rounded bg-muted" />
				<div className="h-2 w-16 animate-pulse rounded bg-muted" />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Workspace row
// ---------------------------------------------------------------------------

function humanize(name: string): string {
	return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type WorkspaceRowProps = {
	workspace: ConductorWorkspace;
	index: number;
	phase: Phase;
	forHelmor?: boolean;
	setLeftRef?: (id: string, el: BeamAnchorElement | null) => void;
	setRightRef?: (id: string, el: BeamAnchorElement | null) => void;
};

function WorkspaceRow({
	workspace,
	index,
	phase,
	forHelmor = false,
	setLeftRef,
	setRightRef,
}: WorkspaceRowProps) {
	const label = humanize(workspace.directoryName);
	const initials = label.slice(0, 2).toUpperCase();
	const transferring = phase === "importing" && !forHelmor;
	const shouldAnimateEntrance = forHelmor;

	return (
		<motion.div
			initial={
				shouldAnimateEntrance ? { opacity: 0, x: 12, scale: 0.98 } : false
			}
			animate={
				transferring
					? { opacity: 0, x: 220, scale: 0.75 }
					: { opacity: 1, x: 0, scale: 1 }
			}
			transition={
				transferring
					? { duration: 0.75, delay: index * 0.09, ease: [0.4, 0, 0.6, 1] }
					: shouldAnimateEntrance
						? {
								duration: 0.55,
								delay: 0.25 + index * 0.12,
								ease: [0, 0, 0.2, 1],
							}
						: { duration: 0 }
			}
			className="relative flex items-center gap-2.5 rounded-lg border border-border/40 bg-sidebar px-3 py-2.5"
		>
			<span
				aria-hidden="true"
				ref={setLeftRef ? (el) => setLeftRef(workspace.id, el) : undefined}
				className="pointer-events-none absolute left-0 top-1/2 size-px -translate-x-1/2 -translate-y-1/2"
			/>
			<span
				aria-hidden="true"
				ref={setRightRef ? (el) => setRightRef(workspace.id, el) : undefined}
				className="pointer-events-none absolute right-0 top-1/2 size-px -translate-y-1/2 translate-x-1/2"
			/>
			{workspace.iconSrc ? (
				<img
					src={workspace.iconSrc}
					alt=""
					className="size-7 shrink-0 rounded-md object-cover"
					draggable={false}
				/>
			) : (
				<div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-accent-foreground/75">
					{initials}
				</div>
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate text-[12px] font-medium text-foreground">
					{label}
				</div>
				<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					{workspace.branch && (
						<>
							<GitBranch className="size-2.5 shrink-0" strokeWidth={2} />
							<span className="truncate">{workspace.branch}</span>
						</>
					)}
				</div>
			</div>
			{forHelmor && (
				<Check
					className="size-3.5 shrink-0"
					strokeWidth={2.5}
					style={{ color: "#1F883D" }}
				/>
			)}
		</motion.div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type ConductorOnboardingProps = {
	onComplete: () => void;
	workspaces?: ConductorWorkspace[];
	isLoadingWorkspaces?: boolean;
};

const MAX_VISIBLE = 5;
const SKELETON_ROWS = 5;
const SKELETON_IDS = Array.from(
	{ length: SKELETON_ROWS },
	(_, i) => `skeleton-${i}`,
);
const LOGO_SIZE = 56;

export function ConductorOnboarding({
	onComplete,
	workspaces = [],
	isLoadingWorkspaces = false,
}: ConductorOnboardingProps) {
	const [phase, setPhase] = useState<Phase>("revealed");
	const [importedCount, setImportedCount] = useState(0);
	const [importError, setImportError] = useState<string | null>(null);
	const [showDoneDetails, setShowDoneDetails] = useState(false);

	const containerRef = useRef<HTMLDivElement>(null);
	const conductorAnchorRef = useRef<BeamAnchorElement>(null);
	const helmorAnchorRef = useRef<BeamAnchorElement>(null);
	const leftWorkspaceRefs = useRef<Map<string, BeamAnchorElement>>(new Map());
	const rightWorkspaceRefs = useRef<Map<string, BeamAnchorElement>>(new Map());

	const setLeftWorkspaceRef = useCallback(
		(id: string, el: BeamAnchorElement | null) => {
			if (el) leftWorkspaceRefs.current.set(id, el);
			else leftWorkspaceRefs.current.delete(id);
		},
		[],
	);

	const setRightWorkspaceRef = useCallback(
		(id: string, el: BeamAnchorElement | null) => {
			if (el) rightWorkspaceRefs.current.set(id, el);
			else rightWorkspaceRefs.current.delete(id);
		},
		[],
	);

	const handleImport = useCallback(async () => {
		if (phase !== "revealed") return;
		setImportError(null);
		setPhase("importing");
		const importStarted = Date.now();
		try {
			const ids = workspaces.filter((w) => !w.alreadyImported).map((w) => w.id);
			await importConductorWorkspaces(ids);
			// Let row fly-out finish, then trigger count + centering in the same tick
			const elapsed = Date.now() - importStarted;
			setTimeout(
				() => {
					setImportedCount(workspaces.length);
					setPhase("done");
					// 1100ms ≈ layout (1.0s) + buffer → show welcome details
					setTimeout(() => {
						setShowDoneDetails(true);
					}, 1100);
				},
				Math.max(1000 - elapsed, 0),
			);
		} catch {
			setImportError("Import failed. Try again.");
			setPhase("revealed");
		}
	}, [phase, workspaces, onComplete]);

	const newCount = workspaces.filter((w) => !w.alreadyImported).length;
	const visible = workspaces.slice(0, MAX_VISIBLE);
	const overflow = Math.max(0, workspaces.length - MAX_VISIBLE);
	const isDone = phase === "done";
	// Keep beams mounted through import so they can play the retraction animation;
	// only remove them when "done" so AnimatePresence fires the exit.
	const showBeams = !isDone && !isLoadingWorkspaces && visible.length > 0;
	const beamWorkspaceIds = isLoadingWorkspaces
		? SKELETON_IDS
		: visible.map((w) => w.id);
	const beamTransferring = phase === "importing";

	// Delay right beams until left beams finish drawing.
	// Left beams: ~0ms (ResizeObserver) + 1.4s pathLength + 0.4s stagger = ~1.8s
	const [showRightBeams, setShowRightBeams] = useState(false);
	useEffect(() => {
		if (!showBeams) {
			setShowRightBeams(false);
			return;
		}
		const tid = setTimeout(() => setShowRightBeams(true), 2000);
		return () => clearTimeout(tid);
	}, [showBeams]);

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background font-sans text-foreground antialiased"
		>
			{/* Drag region */}
			<div
				data-tauri-drag-region
				className="pointer-events-auto absolute inset-x-0 top-0 h-14"
			/>

			<DotGrid />

			{/* Beams — visible from "revealed" through "importing", removed on "done" */}
			<AnimatePresence>
				{showBeams && (
					<>
						<motion.div
							key="left-beams"
							className="absolute inset-0"
							initial={false}
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, transition: { duration: 0.5 } }}
							transition={{ duration: 0 }}
						>
							<MultiBeam
								workspaceRefs={leftWorkspaceRefs}
								logoRef={conductorAnchorRef}
								containerRef={containerRef}
								active={!beamTransferring}
								transferring={beamTransferring}
								workspaceIds={beamWorkspaceIds}
								mode="logo-to-items"
							/>
						</motion.div>
						{showRightBeams && (
							<motion.div
								key="right-beams"
								className="absolute inset-0"
								initial={false}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, transition: { duration: 0.5 } }}
								transition={{ duration: 0 }}
							>
								<MultiBeam
									workspaceRefs={rightWorkspaceRefs}
									logoRef={helmorAnchorRef}
									containerRef={containerRef}
									active={!beamTransferring}
									transferring={beamTransferring}
									workspaceIds={beamWorkspaceIds}
									mode="items-to-logo"
								/>
							</motion.div>
						)}
					</>
				)}
			</AnimatePresence>

			{/* ─── Main layout ─────────────────────────────────────────────────── */}
			<LayoutGroup>
				<motion.div
					layout
					className="relative z-10 flex w-full max-w-[1080px] items-center justify-center gap-56 px-10"
					transition={{
						layout: { duration: isDone ? 1.0 : 0, ease: [0, 0, 0.2, 1] },
					}}
				>
					{/* LEFT: Conductor */}
					<AnimatePresence mode="popLayout">
						{!isDone && (
							<motion.div
								key="conductor-column"
								layout
								initial={false}
								animate={
									beamTransferring
										? { opacity: 0, x: 220, scale: 0.75 }
										: { opacity: 1, x: 0, scale: 1 }
								}
								exit={{ opacity: 0, transition: { duration: 0.15 } }}
								transition={
									beamTransferring
										? { duration: 0.75, ease: [0.4, 0, 0.6, 1] }
										: { duration: 0 }
								}
								className="flex w-[220px] shrink-0 justify-end"
							>
								<div className="relative inline-flex items-center justify-center">
									<span
										aria-hidden="true"
										ref={conductorAnchorRef}
										className="pointer-events-none absolute right-0 top-1/2 size-px -translate-y-1/2 translate-x-1/2"
									/>
									<ConductorLogo
										className="shrink-0 rounded-[11px]"
										style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
									/>
								</div>
							</motion.div>
						)}
					</AnimatePresence>

					{/* CENTER: Workspace list */}
					<AnimatePresence mode="popLayout">
						{!isDone && (
							<motion.div
								key="workspace-list-column"
								layout
								initial={false}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, transition: { duration: 0.15 } }}
								transition={{ duration: 0 }}
								className="flex w-[300px] shrink-0 flex-col gap-1.5"
							>
								{isLoadingWorkspaces
									? SKELETON_IDS.map((id) => (
											<SkeletonRow
												key={id}
												id={id}
												setLeftRef={setLeftWorkspaceRef}
												setRightRef={setRightWorkspaceRef}
											/>
										))
									: visible.map((ws, i) => (
											<WorkspaceRow
												key={ws.id}
												workspace={ws}
												index={i}
												phase={phase}
												setLeftRef={setLeftWorkspaceRef}
												setRightRef={setRightWorkspaceRef}
											/>
										))}
								{(isLoadingWorkspaces || overflow > 0) && (
									<p
										className="px-3 py-0.5 text-[11px] text-primary text-right"
										style={{
											opacity:
												isLoadingWorkspaces || phase === "importing" ? 0 : 0.4,
										}}
									>
										{isLoadingWorkspaces ? "\u00A0" : `+${overflow} more`}
									</p>
								)}
							</motion.div>
						)}
					</AnimatePresence>

					{/* RIGHT: Helmor — layout-animated to center when Conductor exits */}
					<motion.div
						layout
						transition={{ layout: { duration: 1.0, ease: [0, 0, 0.2, 1] } }}
						className={`flex w-[220px] shrink-0 flex-col gap-3 ${isDone ? "items-center" : "items-start"}`}
					>
						<motion.div
							initial={false}
							animate={{ opacity: 1, x: 0 }}
							transition={{ duration: 0 }}
							className={`flex flex-col gap-2 ${isDone ? "items-center" : "items-start"}`}
						>
							<div className="relative inline-flex items-center justify-center">
								<span
									aria-hidden="true"
									ref={helmorAnchorRef}
									className="pointer-events-none absolute -left-1 top-1/2 size-px -translate-x-1/2 -translate-y-1/2"
								/>
								<motion.div
									animate={isDone ? { scale: 1.22 } : { scale: 1 }}
									transition={{ duration: 0.7, ease: [0, 0, 0.2, 1] }}
								>
									<img
										src={helmorLogoSrc}
										alt="Helmor"
										className="shrink-0 rounded-[11px]"
										style={{ width: LOGO_SIZE - 10, height: LOGO_SIZE - 10 }}
										draggable={false}
									/>
								</motion.div>

								{/* Done badge */}
								<AnimatePresence>
									{isDone && (
										<motion.div
											initial={{ scale: 0, opacity: 0 }}
											animate={{ scale: 1, opacity: 1 }}
											transition={{
												type: "spring",
												stiffness: 480,
												damping: 20,
												delay: 0.28,
											}}
											className="absolute -right-2 -top-2 flex size-5 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full text-background"
											style={{ backgroundColor: "#1F883D" }}
										>
											<Check className="size-3" strokeWidth={3} />
										</motion.div>
									)}
								</AnimatePresence>
							</div>

							{/* Counter — stays visible throughout done phase */}
							{isDone && importedCount > 0 && (
								<motion.p
									key="counter"
									initial={{ opacity: 0, y: 5, fontSize: "11px" }}
									animate={{ opacity: 1, y: 0, fontSize: "16px" }}
									transition={{
										opacity: { duration: 0.25 },
										y: { duration: 0.25 },
										fontSize: { duration: 1.0, ease: "easeOut" },
									}}
									className="font-medium text-muted-foreground"
								>
									<NumberTicker value={importedCount} /> imported
								</motion.p>
							)}
						</motion.div>

						{/* Done: workspace list + welcome — after counter settles */}
						<AnimatePresence>
							{isDone && showDoneDetails && (
								<motion.div
									key="done-content"
									initial={{ opacity: 0, height: 0 }}
									animate={{ opacity: 1, height: "auto" }}
									transition={{
										height: { duration: 0.75, ease: [0, 0, 0.2, 1] },
										opacity: { duration: 0.5, delay: 0.3 },
									}}
									style={{ overflow: "hidden" }}
									className="flex flex-col items-center gap-5"
								>
									<div className="flex w-[260px] flex-col gap-1.5">
										{visible.map((ws, i) => (
											<WorkspaceRow
												key={ws.id}
												workspace={ws}
												index={i}
												phase={phase}
												forHelmor
											/>
										))}
										{overflow > 0 && (
											<p className="px-3 py-0.5 text-[11px] text-primary text-right opacity-40">
												+{overflow} more
											</p>
										)}
									</div>

									<motion.div
										initial={{ opacity: 0, y: 6 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ delay: 0.6 }}
										className="flex flex-col items-center gap-4 text-center"
									>
										<div>
											<p className="text-base font-semibold text-foreground">
												Welcome to Helmor
											</p>
											<p className="mt-0.5 text-sm text-muted-foreground">
												{importedCount}{" "}
												{importedCount === 1 ? "workspace" : "workspaces"} ready
											</p>
										</div>
										<button
											type="button"
											onClick={onComplete}
											className="rounded-lg px-7 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 active:opacity-75"
											style={{
												background: "var(--color-foreground)",
												color: "var(--color-background)",
											}}
										>
											Get started
										</button>
									</motion.div>
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				</motion.div>
			</LayoutGroup>

			{/* ─── Bottom actions ───────────────────────────────────────────────── */}
			{!isDone && (
				<div className="relative z-10 mt-10 flex flex-col items-center gap-2.5">
					<AnimatePresence mode="wait">
						{importError && (
							<motion.p
								key="err"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								className="text-[12px] text-destructive"
							>
								{importError}
							</motion.p>
						)}

						{phase === "revealed" && (
							<motion.div
								key="cta"
								initial={false}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -8 }}
								transition={{ duration: 0 }}
								className="flex flex-col items-center gap-2"
							>
								<button
									type="button"
									onClick={() => void handleImport()}
									disabled={isLoadingWorkspaces}
									className="group relative flex items-center gap-2 overflow-hidden rounded-lg px-7 py-3 text-sm font-semibold tracking-[0.01em] transition-opacity hover:opacity-90 active:opacity-75 disabled:opacity-40 disabled:pointer-events-none"
									style={{
										background: "var(--color-foreground)",
										color: "var(--color-background)",
									}}
								>
									<div
										className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover:translate-x-full"
										aria-hidden="true"
									/>
									Import{" "}
									{newCount > 0
										? `${newCount} workspace${newCount !== 1 ? "s" : ""}`
										: "workspaces"}
									<ArrowRight
										className="size-3.5 transition-transform group-hover:translate-x-0.5"
										strokeWidth={2.5}
									/>
								</button>
								<button
									type="button"
									onClick={onComplete}
									className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
								>
									Skip for now
								</button>
							</motion.div>
						)}

						{phase === "importing" && (
							<motion.div
								key="loading"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								className="flex items-center gap-2 text-sm text-muted-foreground"
							>
								<motion.span
									className="inline-block size-4 rounded-full border-2 border-border border-t-foreground"
									animate={{ rotate: 360 }}
									transition={{
										duration: 0.75,
										repeat: Number.POSITIVE_INFINITY,
										ease: "linear",
									}}
								/>
								Importing…
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			)}
		</div>
	);
}
