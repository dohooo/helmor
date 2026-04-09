import { ArrowRight, Check, GitBranch } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import conductorLogoSrc from "@/assets/conductor.webp";
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
				backgroundImage: `radial-gradient(circle, color-mix(in oklch, var(--color-app-foreground) 9%, transparent) 1px, transparent 1px)`,
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
// Helmor logo — concentric ring + H
// ---------------------------------------------------------------------------

function HelmorLogo({
	className,
	size = 56,
}: {
	className?: string;
	size?: number;
}) {
	return (
		<svg
			viewBox="0 0 64 64"
			fill="none"
			className={className}
			style={{ width: size, height: size }}
			xmlns="http://www.w3.org/2000/svg"
			aria-label="Helmor"
		>
			<circle
				cx="32"
				cy="32"
				r="29"
				stroke="currentColor"
				strokeWidth="1"
				strokeOpacity="0.18"
				strokeDasharray="2 4"
			/>
			<circle cx="32" cy="32" r="23" fill="currentColor" fillOpacity="0.09" />
			<circle
				cx="32"
				cy="32"
				r="23"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeOpacity="0.3"
			/>
			<path
				d="M20 18v28M44 18v28M20 32h24"
				stroke="currentColor"
				strokeWidth="4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Multi-beam
// ---------------------------------------------------------------------------

type BeamEntry = { id: string; d: string; delay: number };

type MultiBeamProps = {
	workspaceRefs: React.RefObject<Map<string, HTMLDivElement>>;
	helmorIconRef: React.RefObject<HTMLDivElement | null>;
	containerRef: React.RefObject<HTMLDivElement | null>;
	/** true = fully active (dots cycling), false = idle (paths only) */
	active: boolean;
	/** true = retract all beams toward Helmor and fade dots */
	transferring: boolean;
	workspaceIds: string[];
};

function MultiBeam({
	workspaceRefs,
	helmorIconRef,
	containerRef,
	active,
	transferring,
	workspaceIds,
}: MultiBeamProps) {
	const gradId = useId();
	const [beams, setBeams] = useState<BeamEntry[]>([]);

	useEffect(() => {
		function recalc() {
			const container = containerRef.current;
			const helmorEl = helmorIconRef.current;
			if (!container || !helmorEl) return;

			const cr = container.getBoundingClientRect();
			const hr = helmorEl.getBoundingClientRect();
			// Stop beam just outside the icon's left edge (outer circle ≈ 2px inside bounding box)
			const ex = hr.left - cr.left - 6;
			const ey = hr.top + hr.height / 2 - cr.top;

			const newBeams: BeamEntry[] = [];
			workspaceIds.forEach((id, i) => {
				const el = workspaceRefs.current?.get(id);
				if (!el) return;
				const wr = el.getBoundingClientRect();
				const sx = wr.right - cr.left;
				const sy = wr.top + wr.height / 2 - cr.top;
				const midX = sx + (ex - sx) * 0.5;
				newBeams.push({
					id,
					d: `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ey}, ${ex} ${ey}`,
					delay: i * 0.1,
				});
			});
			setBeams(newBeams);
		}

		// Measure after layout + entrance animations have settled (beams fade in at 0.8s).
		const tid = setTimeout(() => requestAnimationFrame(recalc), 650);
		const ro = new ResizeObserver(recalc);
		if (containerRef.current) ro.observe(containerRef.current);
		if (helmorIconRef.current) ro.observe(helmorIconRef.current);
		return () => {
			clearTimeout(tid);
			ro.disconnect();
		};
	}, [workspaceIds, workspaceRefs, helmorIconRef, containerRef]);

	if (!beams.length) return null;

	return (
		<>
			{/* SVG layer — paths */}
			<svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
				<defs>
					<linearGradient id={`${gradId}-g`} x1="0%" y1="0%" x2="100%" y2="0%">
						<stop
							offset="0%"
							stopColor="var(--color-app-foreground)"
							stopOpacity="0"
						/>
						<stop
							offset="50%"
							stopColor="var(--color-app-foreground)"
							stopOpacity="0.4"
						/>
						<stop
							offset="100%"
							stopColor="var(--color-app-foreground)"
							stopOpacity="0"
						/>
					</linearGradient>
				</defs>

				{beams.map((beam) => (
					<g key={beam.id}>
						{/* Background rail — retracts toward Helmor when transferring */}
						<motion.path
							d={beam.d}
							fill="none"
							stroke="var(--color-app-border)"
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
				beams.map((beam) => (
					<motion.div
						key={`dot-${beam.id}`}
						className="pointer-events-none absolute left-0 top-0 size-[5px] rounded-full"
						style={{
							background: "var(--color-app-foreground)",
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

function SkeletonRow({ index }: { index: number }) {
	return (
		<motion.div
			initial={{ opacity: 0, x: -10 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay: index * 0.1, duration: 0.5 }}
			className="flex items-center gap-2.5 rounded-lg border border-app-border/30 bg-app-sidebar px-3 py-2.5"
		>
			<div className="size-7 shrink-0 animate-pulse rounded-md bg-app-accent" />
			<div className="flex-1 space-y-1.5">
				<div className="h-2.5 w-28 animate-pulse rounded bg-app-accent" />
				<div className="h-2 w-16 animate-pulse rounded bg-app-accent" />
			</div>
		</motion.div>
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
	setRef?: (id: string, el: HTMLDivElement | null) => void;
};

function WorkspaceRow({
	workspace,
	index,
	phase,
	forHelmor = false,
	setRef,
}: WorkspaceRowProps) {
	const label = humanize(workspace.directoryName);
	const initials = label.slice(0, 2).toUpperCase();
	const transferring = phase === "importing" && !forHelmor;

	return (
		<motion.div
			ref={setRef ? (el) => setRef(workspace.id, el) : undefined}
			initial={{ opacity: 0 }}
			animate={
				transferring
					? { opacity: 0, x: 220, scale: 0.75 }
					: { opacity: 1, x: 0, scale: 1 }
			}
			transition={
				transferring
					? { duration: 0.75, delay: index * 0.09, ease: [0.4, 0, 0.6, 1] }
					: {
							duration: 0.7,
							delay: forHelmor ? 0.25 + index * 0.12 : 0.35 + index * 0.12,
							ease: [0, 0, 0.2, 1],
						}
			}
			className="flex items-center gap-2.5 rounded-lg border border-app-border/40 bg-app-sidebar px-3 py-2.5"
		>
			<div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-app-accent text-[10px] font-bold text-app-foreground-soft">
				{initials}
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[12px] font-medium text-app-foreground">
					{label}
				</div>
				<div className="flex items-center gap-1.5 text-[10px] text-app-muted">
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
					className="size-3.5 shrink-0 text-app-positive"
					strokeWidth={2.5}
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
const SKELETON_ROWS = 4;
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
	const helmorIconRef = useRef<HTMLDivElement>(null);
	const workspaceRefs = useRef<Map<string, HTMLDivElement>>(new Map());

	const setWorkspaceRef = useCallback(
		(id: string, el: HTMLDivElement | null) => {
			if (el) workspaceRefs.current.set(id, el);
			else workspaceRefs.current.delete(id);
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
						setTimeout(onComplete, 2800);
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
	const beamTransferring = phase === "importing";

	return (
		<div
			ref={containerRef}
			className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-app-base font-sans text-app-foreground antialiased"
		>
			{/* Drag region */}
			<div
				data-tauri-drag-region
				className="pointer-events-auto absolute inset-x-0 top-0 h-14"
			/>

			<DotGrid />
			<div
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(ellipse 80% 70% at 50% 50%, color-mix(in oklch, var(--color-app-foreground) 3%, transparent), transparent)",
				}}
			/>

			{/* Beams — visible from "revealed" through "importing", removed on "done" */}
			<AnimatePresence>
				{showBeams && (
					<motion.div
						key="beams"
						className="absolute inset-0"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.5 } }}
						transition={{ duration: 0.8, delay: 0.8 }}
					>
						<MultiBeam
							workspaceRefs={workspaceRefs}
							helmorIconRef={helmorIconRef}
							containerRef={containerRef}
							active={!beamTransferring}
							transferring={beamTransferring}
							workspaceIds={visible.map((w) => w.id)}
						/>
					</motion.div>
				)}
			</AnimatePresence>

			{/* ─── Main layout ─────────────────────────────────────────────────── */}
			<LayoutGroup>
				<motion.div
					layout
					className="relative z-10 flex w-full max-w-[760px] items-start px-14"
					style={{ justifyContent: isDone ? "center" : "space-between" }}
					transition={{ layout: { duration: 1.0, ease: [0, 0, 0.2, 1] } }}
				>
					{/* LEFT: Conductor */}
					<AnimatePresence mode="popLayout">
						{!isDone && (
							<motion.div
								key="conductor"
								layout
								style={{ width: 300 }}
								className="flex flex-col gap-4"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0, transition: { duration: 0.15 } }}
								transition={{ duration: 0.35, ease: "easeOut" }}
							>
								{/* Header fades out on its own when importing starts */}
								<motion.div
									initial={{ opacity: 0, y: -8 }}
									animate={{
										opacity: phase === "importing" ? 0 : 1,
										y: 0,
									}}
									transition={
										phase === "importing"
											? { duration: 0.55, delay: 0.15 }
											: { duration: 0.75, delay: 0.3 }
									}
									className="flex items-center gap-3"
								>
									<ConductorLogo
										className="shrink-0 rounded-[11px]"
										style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
									/>
									{workspaces.length > 0 && (
										<span className="rounded-full bg-app-accent px-2.5 py-0.5 text-[11px] font-medium text-app-foreground-soft">
											{workspaces.length}
										</span>
									)}
								</motion.div>

								{/* Workspace list */}
								<div className="flex flex-col gap-1.5">
									{isLoadingWorkspaces
										? Array.from({ length: SKELETON_ROWS }, (_, i) => (
												<SkeletonRow key={i} index={i} />
											))
										: visible.map((ws, i) => (
												<WorkspaceRow
													key={ws.id}
													workspace={ws}
													index={i}
													phase={phase}
													setRef={setWorkspaceRef}
												/>
											))}
									{overflow > 0 && !isLoadingWorkspaces && (
										<motion.p
											initial={{ opacity: 0 }}
											animate={{ opacity: phase === "importing" ? 0 : 0.4 }}
											transition={{ delay: 0.5 }}
											className="px-3 py-0.5 text-[11px] text-app-muted"
										>
											+{overflow} more
										</motion.p>
									)}
								</div>
							</motion.div>
						)}
					</AnimatePresence>

					{/* RIGHT: Helmor — layout-animated to center when Conductor exits */}
					<motion.div
						layout
						transition={{ layout: { duration: 1.0, ease: [0, 0, 0.2, 1] } }}
						className="flex flex-col items-center gap-3"
					>
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.8, delay: 0.35 }}
							className="flex flex-col items-center gap-2"
						>
							{/* helmorIconRef — beam endpoint is measured from here */}
							<div
								ref={helmorIconRef}
								className="relative inline-flex items-center justify-center"
							>
								{/* Pulse rings during import */}
								<AnimatePresence>
									{phase === "importing" &&
										[0, 1, 2].map((i) => (
											<motion.div
												key={i}
												className="absolute rounded-full border border-app-foreground/20"
												style={{ inset: 0 }}
												initial={{ scale: 1, opacity: 0.45 }}
												animate={{ scale: 2.8 + i * 0.55, opacity: 0 }}
												transition={{
													duration: 2.2,
													delay: i * 0.6,
													repeat: Number.POSITIVE_INFINITY,
													ease: "easeOut",
												}}
											/>
										))}
								</AnimatePresence>

								<motion.div
									animate={isDone ? { scale: 1.22 } : { scale: 1 }}
									transition={{ duration: 0.7, ease: [0, 0, 0.2, 1] }}
								>
									<HelmorLogo
										size={LOGO_SIZE}
										className={`relative transition-colors duration-500 ${isDone ? "text-app-foreground" : "text-app-foreground-soft"}`}
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
											className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-app-positive text-white"
										>
											<Check className="size-3" strokeWidth={3} />
										</motion.div>
									)}
								</AnimatePresence>
							</div>

							<motion.span
								animate={
									isDone
										? { fontWeight: 700, fontSize: "1rem" }
										: { fontWeight: 600, fontSize: "0.875rem" }
								}
								transition={{ duration: 0.45 }}
								className="text-app-foreground"
							>
								Helmor
							</motion.span>

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
									className="font-medium text-app-foreground-soft"
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
											<p className="px-3 py-0.5 text-[11px] text-app-muted opacity-40">
												+{overflow} more
											</p>
										)}
									</div>

									<motion.div
										initial={{ opacity: 0, y: 6 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ delay: 0.6 }}
										className="text-center"
									>
										<p className="text-base font-semibold text-app-foreground">
											Welcome to Helmor
										</p>
										<p className="mt-0.5 text-sm text-app-muted">
											{importedCount}{" "}
											{importedCount === 1 ? "workspace" : "workspaces"} ready
										</p>
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
								className="text-[12px] text-app-negative"
							>
								{importError}
							</motion.p>
						)}

						{phase === "revealed" && !isLoadingWorkspaces && (
							<motion.div
								key="cta"
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -8 }}
								transition={{ duration: 0.55, delay: 0.5 }}
								className="flex flex-col items-center gap-2"
							>
								<button
									type="button"
									onClick={() => void handleImport()}
									className="group relative flex items-center gap-2 overflow-hidden rounded-lg px-7 py-3 text-sm font-semibold tracking-[0.01em] transition-opacity hover:opacity-90 active:opacity-75"
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
									className="text-[11px] text-app-muted transition-colors hover:text-app-foreground-soft"
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
								className="flex items-center gap-2 text-sm text-app-foreground-soft"
							>
								<motion.span
									className="inline-block size-4 rounded-full border-2 border-app-border border-t-app-foreground"
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
