---
"helmor": patch
---

Add a Claude Design button to the sidebar that opens `claude.ai/design` as a full-window embedded browser:
- A dedicated sidebar entry under the "Workspaces" header launches a native WKWebView overlay filling the whole Helmor window; the X in its top bar returns to the main UI while preserving the webview's login state and page position across open/close cycles.
- Google sign-in attempts are intercepted (embedded WebViews cannot complete Google OAuth) and replaced with a modal offering two paths: use email/magic-link sign-in in place, or import an existing claude.ai session from Chrome / Arc / Brave / Edge / Firefox — if no cookies are found we auto-open the chosen browser to claude.ai so the user can sign in there first, then retry.
