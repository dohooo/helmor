import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
	title: "Helmor — The local-first IDE for coding agent orchestration",
	description:
		"Run Claude Code and Codex side-by-side across worktrees, on your machine. Plan. Run. Review — without handing your source tree to a vendor.",
	icons: {
		icon: "/helmor-logo-dark.svg",
	},
};

export const viewport: Viewport = {
	themeColor: "#2a2a2a",
	colorScheme: "dark light",
	// Mobile/tablet-only concerns — desktop browsers ignore these.
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
};

// Inlined to run before first paint. Preference order:
//   1. Stored choice (localStorage) if previously set via the theme toggle.
//   2. System preference (prefers-color-scheme).
//   3. Fall back to SSR default (dark) if neither is available.
// Without the system-pref fallback, a system-light visitor with no stored
// choice would see a dark → light flash as soon as React mounted and flipped.
const THEME_BOOTSTRAP = `
(function(){
  try {
    var m = null;
    var raw = localStorage.getItem('helmor-marketing-theme');
    if (raw) {
      try {
        var p = JSON.parse(raw);
        if (p === 'light' || p === 'dark') m = p;
      } catch (_) {}
    }
    if (!m && typeof window.matchMedia === 'function') {
      m = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    if (!m) m = 'dark';
    document.documentElement.classList.toggle('dark', m === 'dark');
    document.documentElement.classList.toggle('light', m === 'light');
  } catch (_) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
	// `suppressHydrationWarning` on <html>: the THEME_BOOTSTRAP script below
	// runs before hydration and flips the className to "light" if that's what
	// the user previously stored. React would otherwise flag the intentional
	// server/client attribute divergence. Scoped to one attribute — does not
	// suppress any real hydration issues in descendants.
	return (
		<html lang="en" className="dark" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
			</head>
			<body>{children}</body>
		</html>
	);
}
