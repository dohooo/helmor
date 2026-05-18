"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoData } from "@/lib/github";
import { DownloadDropdown } from "./download-dropdown";

type Theme = "light" | "dark";

const STORAGE_KEY = "helmor-marketing-theme";
// Keep the product preview tilt subtle so it reads as ambient polish.
const MAX_TILT_DEG = 4;
// Atmospheric FX — backlit dust mote count. 18 is the sweet spot from the
// v2 prototype: enough to read as "air has particles in it" without turning
// into confetti or stealing focus from the smoke plumes.
const DUST_COUNT = 18;

export function MarketingShell({ data }: { data: RepoData }) {
	// SSR default mirrors <html class="dark"> in layout; a useEffect reconciles
	// against localStorage to avoid hydration mismatch.
	const [theme, setTheme] = useState<Theme>("dark");

	// Mount: read persisted theme + sync <html class>. Matches the
	// pre-hydration bootstrap in layout.tsx: stored LS > system prefs > dark.
	useEffect(() => {
		let initial: Theme | null = null;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (parsed === "light" || parsed === "dark") initial = parsed;
			}
		} catch {
			/* noop */
		}
		if (!initial) {
			initial = window.matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark";
		}
		setTheme(initial);
	}, []);

	// Apply theme changes. First run is skipped: the pre-hydration bootstrap
	// in layout.tsx has already set <html class>, and the mount-theme-init
	// useEffect above reconciles React state. Without this guard, the initial
	// state ("dark" on SSR) would briefly revert the bootstrap's class before
	// the init's setTheme re-renders us back — a visible flash, plus it would
	// kick off the .shot.light-layer clip-path transition.
	const hasMountedRef = useRef(false);
	useEffect(() => {
		if (!hasMountedRef.current) {
			hasMountedRef.current = true;
			return;
		}
		const root = document.documentElement;
		root.classList.toggle("dark", theme === "dark");
		root.classList.toggle("light", theme === "light");
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
		} catch {
			/* noop */
		}
	}, [theme]);

	const toggleTheme = useCallback((mode: Theme) => setTheme(mode), []);

	// `T` / `t` toggles the theme globally.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA")
			) {
				return;
			}
			if (e.key === "t" || e.key === "T") {
				setTheme((prev) => (prev === "dark" ? "light" : "dark"));
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	// 3D tilt + atmospheric smoke swirl — cursor-driven. Tilt and smoke swirl
	// are gated on prefers-reduced-motion.
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const smokeRef = useRef<HTMLDivElement | null>(null);
	const dustRef = useRef<HTMLDivElement | null>(null);

	// Spawn backlit dust motes — 18 tiny particles scattered across the right
	// half of the stage that drift toward upper-left. Randomized per mount so
	// Math.random doesn't cause hydration issues (render nothing on SSR).
	useEffect(() => {
		const host = dustRef.current;
		if (!host) return;
		host.replaceChildren();
		for (let i = 0; i < DUST_COUNT; i++) {
			const d = document.createElement("i");
			const startX = 55 + Math.random() * 45;
			const startY = 10 + Math.random() * 80;
			const tx = -60 - Math.random() * 120;
			const ty = -30 + (Math.random() * 60 - 30);
			const dur = 12 + Math.random() * 16;
			const del = -Math.random() * dur;
			d.style.left = `${startX}%`;
			d.style.top = `${startY}%`;
			d.style.setProperty("--tx", `${tx}px`);
			d.style.setProperty("--ty", `${ty}px`);
			d.style.setProperty("--d", `${dur}s`);
			d.style.setProperty("--del", `${del}s`);
			d.style.animationDelay = `${del}s`;
			host.appendChild(d);
		}
	}, []);

	useEffect(() => {
		const wrap = wrapRef.current;
		const stage = stageRef.current;
		if (!wrap || !stage) return;

		const prefersReduced = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;

		let targetRX = 0;
		let targetRY = 0;
		let curRX = 0;
		let curRY = 0;
		let rafId: number | null = null;

		const tick = () => {
			curRX += (targetRX - curRX) * 0.12;
			curRY += (targetRY - curRY) * 0.12;
			stage.style.transform = `rotateX(${curRX.toFixed(2)}deg) rotateY(${curRY.toFixed(2)}deg)`;
			if (
				Math.abs(curRX - targetRX) > 0.01 ||
				Math.abs(curRY - targetRY) > 0.01
			) {
				rafId = requestAnimationFrame(tick);
			} else {
				rafId = null;
			}
		};
		const schedule = () => {
			if (rafId == null) rafId = requestAnimationFrame(tick);
		};

		const onMove = (e: PointerEvent) => {
			const rect = stage.getBoundingClientRect();

			// Smoke swirl — write 0..1 cursor position within the mock-wrap so
			// each plume's --swirl-offset translates toward the cursor. Swirl
			// strength peaks near the horizontal midline of the product frame.
			const smoke = smokeRef.current;
			if (smoke && !prefersReduced) {
				const wrapRect = wrap.getBoundingClientRect();
				const wx = Math.max(
					0,
					Math.min(1, (e.clientX - wrapRect.left) / wrapRect.width),
				);
				const wy = Math.max(
					0,
					Math.min(1, (e.clientY - wrapRect.top) / wrapRect.height),
				);
				smoke.style.setProperty("--cursor-x", wx.toFixed(3));
				smoke.style.setProperty("--cursor-y", wy.toFixed(3));
				const prox = 1 - Math.min(1, Math.hypot(wx - 0.5, wy - 0.5) * 1.6);
				smoke.style.setProperty(
					"--swirl-strength",
					(0.4 + prox * 1.2).toFixed(3),
				);
			}

			if (prefersReduced) return;

			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const dx = (e.clientX - cx) / (rect.width / 2);
			const dy = (e.clientY - cy) / (rect.height / 2);
			targetRY = Math.max(-1, Math.min(1, dx)) * MAX_TILT_DEG;
			targetRX = -Math.max(-1, Math.min(1, dy)) * MAX_TILT_DEG;
			schedule();
		};
		const onLeave = () => {
			// Smoke swirl — ease plumes back to center.
			const smoke = smokeRef.current;
			if (smoke) {
				smoke.style.setProperty("--cursor-x", "0.5");
				smoke.style.setProperty("--cursor-y", "0.5");
				smoke.style.setProperty("--swirl-strength", "0.4");
			}

			if (prefersReduced) return;

			targetRX = 0;
			targetRY = 0;
			schedule();
		};

		wrap.addEventListener("pointermove", onMove);
		wrap.addEventListener("pointerleave", onLeave);
		return () => {
			wrap.removeEventListener("pointermove", onMove);
			wrap.removeEventListener("pointerleave", onLeave);
			if (rafId != null) cancelAnimationFrame(rafId);
		};
	}, []);

	return (
		<div className="page">
			{/* ============== TOP RAIL ============== */}
			<div className="rail">
				<a className="brand" href="/">
					{/* Both logo variants render; CSS on <html class> picks the right
					 * one. Keeps the first paint correct for system-light visitors
					 * without a React-driven src swap flashing the dark logo. */}
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						className="brand-mark-dark"
						src="/helmor-logo-dark.svg"
						alt=""
						aria-hidden="true"
					/>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						className="brand-mark-light"
						src="/helmor-logo-light.svg"
						alt=""
						aria-hidden="true"
					/>
					Helmor
				</a>
				<span className="version">{data.version}</span>
				<div className="links">
					<a href={`${data.repoUrl}#readme`}>Docs</a>
					<a href={data.releasesUrl}>Changelog</a>
					<a href={`${data.repoUrl}/discussions`}>Discussions</a>
				</div>
				<div className="spacer" />
				<div className="theme-toggle" role="tablist" aria-label="Theme">
					<button
						type="button"
						aria-label="Light"
						aria-pressed={theme === "light"}
						className={theme === "light" ? "active" : undefined}
						onClick={() => toggleTheme("light")}
					>
						<SunIcon />
					</button>
					<button
						type="button"
						aria-label="Dark"
						aria-pressed={theme === "dark"}
						className={theme === "dark" ? "active" : undefined}
						onClick={() => toggleTheme("dark")}
					>
						<MoonIcon />
					</button>
				</div>
			</div>

			{/* ============== STAGE ============== */}
			<div className="stage">
				{/* Atmospheric FX — spans BOTH columns so smoke drifts behind
				 * the pitch text AND around the product screenshot. Sits under
				 * .pitch (z:2) and .mock-wrap (z:3) via z-index stacking. */}
				<div className="atmos" aria-hidden="true">
					<div className="light-burst" />
					<div className="smoke" ref={smokeRef}>
						{/* Back plume — largest, slowest, coolest-toned */}
						<div className="plume plume-back">
							<div className="smoke-swirl">
								<svg
									viewBox="0 0 800 600"
									preserveAspectRatio="xMidYMid slice"
									aria-hidden="true"
								>
									<defs>
										<filter
											id="turb-back"
											x="-10%"
											y="-10%"
											width="120%"
											height="120%"
										>
											<feTurbulence
												type="fractalNoise"
												baseFrequency="0.008 0.014"
												numOctaves={3}
												seed={3}
												result="noise"
											/>
											<feDisplacementMap
												in="SourceGraphic"
												in2="noise"
												scale={90}
												xChannelSelector="R"
												yChannelSelector="G"
											/>
										</filter>
										<radialGradient id="grad-back" cx="72%" cy="50%" r="55%">
											<stop
												offset="0%"
												stopColor="oklch(0.95 0.05 245)"
												stopOpacity={1}
											/>
											<stop
												offset="30%"
												stopColor="oklch(0.75 0.12 250)"
												stopOpacity={0.85}
											/>
											<stop
												offset="60%"
												stopColor="oklch(0.50 0.13 258)"
												stopOpacity={0.5}
											/>
											<stop
												offset="100%"
												stopColor="oklch(0.25 0.08 265)"
												stopOpacity={0}
											/>
										</radialGradient>
									</defs>
									<g filter="url(#turb-back)">
										<ellipse
											cx={560}
											cy={280}
											rx={320}
											ry={230}
											fill="url(#grad-back)"
										/>
										<ellipse
											cx={420}
											cy={350}
											rx={260}
											ry={190}
											fill="url(#grad-back)"
											opacity={0.85}
										/>
										<ellipse
											cx={620}
											cy={420}
											rx={220}
											ry={160}
											fill="url(#grad-back)"
											opacity={0.75}
										/>
										<ellipse
											cx={300}
											cy={290}
											rx={180}
											ry={140}
											fill="url(#grad-back)"
											opacity={0.6}
										/>
										<ellipse
											cx={500}
											cy={170}
											rx={200}
											ry={130}
											fill="url(#grad-back)"
											opacity={0.65}
										/>
									</g>
								</svg>
							</div>
						</div>

						{/* Mid plume — brightest, medium turbulence */}
						<div className="plume plume-mid">
							<div className="smoke-swirl">
								<svg
									viewBox="0 0 800 600"
									preserveAspectRatio="xMidYMid slice"
									aria-hidden="true"
								>
									<defs>
										<filter
											id="turb-mid"
											x="-10%"
											y="-10%"
											width="120%"
											height="120%"
										>
											<feTurbulence
												type="fractalNoise"
												baseFrequency="0.018 0.028"
												numOctaves={4}
												seed={7}
												result="noise"
											/>
											<feDisplacementMap
												in="SourceGraphic"
												in2="noise"
												scale={65}
												xChannelSelector="R"
												yChannelSelector="G"
											/>
										</filter>
										<radialGradient id="grad-mid" cx="70%" cy="48%" r="50%">
											<stop
												offset="0%"
												stopColor="oklch(0.98 0.03 245)"
												stopOpacity={1}
											/>
											<stop
												offset="25%"
												stopColor="oklch(0.85 0.09 245)"
												stopOpacity={0.9}
											/>
											<stop
												offset="55%"
												stopColor="oklch(0.58 0.13 252)"
												stopOpacity={0.45}
											/>
											<stop
												offset="100%"
												stopColor="oklch(0.28 0.08 258)"
												stopOpacity={0}
											/>
										</radialGradient>
									</defs>
									<g filter="url(#turb-mid)">
										<ellipse
											cx={540}
											cy={300}
											rx={240}
											ry={180}
											fill="url(#grad-mid)"
										/>
										<ellipse
											cx={420}
											cy={220}
											rx={170}
											ry={130}
											fill="url(#grad-mid)"
											opacity={0.85}
										/>
										<ellipse
											cx={600}
											cy={390}
											rx={190}
											ry={140}
											fill="url(#grad-mid)"
											opacity={0.85}
										/>
										<ellipse
											cx={340}
											cy={380}
											rx={150}
											ry={110}
											fill="url(#grad-mid)"
											opacity={0.75}
										/>
										<ellipse
											cx={260}
											cy={260}
											rx={130}
											ry={100}
											fill="url(#grad-mid)"
											opacity={0.55}
										/>
									</g>
								</svg>
							</div>
						</div>

						{/* Front plume — tightest curls, highest frequency */}
						<div className="plume plume-front">
							<div className="smoke-swirl">
								<svg
									viewBox="0 0 800 600"
									preserveAspectRatio="xMidYMid slice"
									aria-hidden="true"
								>
									<defs>
										<filter
											id="turb-front"
											x="-10%"
											y="-10%"
											width="120%"
											height="120%"
										>
											<feTurbulence
												type="fractalNoise"
												baseFrequency="0.035 0.050"
												numOctaves={5}
												seed={11}
												result="noise"
											/>
											<feDisplacementMap
												in="SourceGraphic"
												in2="noise"
												scale={45}
												xChannelSelector="R"
												yChannelSelector="G"
											/>
										</filter>
										<radialGradient id="grad-front" cx="68%" cy="45%" r="42%">
											<stop
												offset="0%"
												stopColor="oklch(1 0 0)"
												stopOpacity={1}
											/>
											<stop
												offset="20%"
												stopColor="oklch(0.93 0.05 245)"
												stopOpacity={0.95}
											/>
											<stop
												offset="50%"
												stopColor="oklch(0.68 0.12 250)"
												stopOpacity={0.5}
											/>
											<stop
												offset="100%"
												stopColor="oklch(0.32 0.09 255)"
												stopOpacity={0}
											/>
										</radialGradient>
									</defs>
									<g filter="url(#turb-front)">
										<ellipse
											cx={520}
											cy={290}
											rx={180}
											ry={140}
											fill="url(#grad-front)"
										/>
										<ellipse
											cx={400}
											cy={340}
											rx={130}
											ry={100}
											fill="url(#grad-front)"
											opacity={0.85}
										/>
										<ellipse
											cx={580}
											cy={360}
											rx={140}
											ry={105}
											fill="url(#grad-front)"
											opacity={0.8}
										/>
										<ellipse
											cx={460}
											cy={200}
											rx={110}
											ry={85}
											fill="url(#grad-front)"
											opacity={0.75}
										/>
										<ellipse
											cx={300}
											cy={280}
											rx={100}
											ry={75}
											fill="url(#grad-front)"
											opacity={0.55}
										/>
									</g>
								</svg>
							</div>
						</div>
					</div>
					{/* Backlit dust motes — populated in useEffect */}
					<div className="dust" ref={dustRef} />
				</div>

				{/* LEFT — pitch */}
				<div className="pitch">
					<a className="changelog-chip" href={data.latestReleaseUrl}>
						<span className="tag">{data.versionShort}</span>
						Codex 1.0 and Claude Code 2.0 now supported
						<span className="arrow">→</span>
					</a>

					<h1 className="hero">
						<span className="line2">AI made coding faster.</span>
						<span className="and" />
						Helmor is about finishing the rest of the loop.
					</h1>

					<p className="sub">
						An open-source local workbench for multi-agent software development.
						Built for orchestration, review, testing, merge, and everything
						around the code.
					</p>

					<div className="cta">
						<DownloadDropdown data={data} />
						<a className="btn outline" href={data.repoUrl}>
							<GithubIcon />
							View on GitHub
						</a>
					</div>

					<div className="meta">
						<span>
							<span className="ok">●</span> {data.branch} · {data.shortSha}
						</span>
						<span className="sep" />
						<span>{data.license}</span>
						<span className="sep" />
						<span>macOS</span>
					</div>
				</div>

				{/* RIGHT — interactive product screenshot */}
				<div className="mock-wrap" ref={wrapRef}>
					<div
						className="mock-stage"
						aria-label="Helmor product preview"
						ref={stageRef}
					>
						<div className="shot dark-layer">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src="/helmor-screenshot-dark.png"
								alt="Helmor (dark)"
								draggable={false}
							/>
						</div>
						<div className="shot light-layer">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src="/helmor-screenshot-light.png"
								alt="Helmor (light)"
								draggable={false}
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------- Inline SVG icons (lucide-equivalent, no runtime dep) ----------

function SunIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	);
}

function GithubIcon() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.93c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.04-.72.08-.7.08-.7 1.16.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.17a11 11 0 0 1 5.78 0c2.21-1.48 3.17-1.17 3.17-1.17.63 1.59.23 2.77.12 3.06.74.8 1.18 1.82 1.18 3.08 0 4.41-2.7 5.39-5.27 5.67.42.36.78 1.05.78 2.13v3.15c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
		</svg>
	);
}
