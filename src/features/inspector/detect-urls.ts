/**
 * Detect localhost-style dev-server URLs from PTY shell output.
 *
 * The Run script runs inside a PTY with `TERM=xterm-256color` and colour
 * forcing, so almost every framework prints its "ready" banner wrapped in
 * ANSI escape codes. We strip those first, then run a conservative regex
 * that only matches `http(s)://{localhost,127.0.0.1,0.0.0.0}[:PORT][/path]`
 * — the three host forms frameworks actually print for local dev.
 *
 * This is a best-effort, MVP-grade detector. It:
 *   - Covers Vite (`Local:   http://localhost:5173/`), Next.js, CRA,
 *     Rails-style banners, and plain `http://localhost:PORT` in prose.
 *   - Will not match `http://192.168.1.50:5173` (LAN) or custom domains.
 *   - Normalizes 127.0.0.1/0.0.0.0 → `localhost` (browsers choke on 0.0.0.0).
 *   - Strips trailing sentence punctuation (`.`, `,`, `;`, `:`, `!`, `?`).
 */

// Standard ANSI escape sequence pattern from the `ansi-regex` package (MIT).
// Covers CSI / OSC / operating-system commands and the BEL terminator.
// Constructed via `new RegExp(string)` so the formatter won't wrap a long
// literal — wrapping would push the biome-ignore out of range.
// biome-ignore lint/complexity/useRegexLiterals: literal form triggers noControlCharactersInRegex on unfixable lines
const ANSI_RE = new RegExp(
	"[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
	"g",
);

// Match http(s) URLs pointing at the three canonical local hosts. The path
// portion stops at whitespace, quotes, angle brackets, and closing parens —
// anything that's clearly URL-terminating in prose.
const LOCAL_URL_RE =
	/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`<>)\]]*)?/gi;

// Marker a run script prints to declare the URL Helmor should offer in the
// Open menu. Anchored to the start of a line (leading whitespace allowed) so
// it can't be triggered by a URL appearing mid-prose. The host part is
// deliberately unrestricted — unlike LOCAL_URL_RE this must accept named
// domains, which is the entire point of the feature.
const DECLARED_URL_RE = /^[ \t]*helmor:url=(https?:\/\/[^\s"'`<>]+)/gim;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_RE, "");
}

/**
 * Extract URLs a run script has explicitly declared via `helmor:url=<URL>`
 * lines in its output.
 *
 * Sniffing `http://localhost:PORT` out of stdout works for plain dev servers
 * but breaks under a reverse proxy: with portless, Caddy, ngrok, or Tailscale
 * Funnel the services behind the proxy print ephemeral ports that are neither
 * reachable nor stable, while the address users actually need is a named
 * domain nobody prints in a recognizable banner. Declaring it explicitly is
 * the escape hatch:
 *
 *     echo "helmor:url=https://${HELMOR_WORKSPACE_NAME}.localhost"
 *
 * Repeating the marker declares multiple URLs (e.g. web + api in a monorepo),
 * which surface in the Open menu's picker. Declared URLs take precedence over
 * sniffed ones — see the script store.
 */
export function extractDeclaredUrls(input: string): string[] {
	const clean = stripAnsi(input);
	const out: string[] = [];
	// Shared regex object with the `g` flag carries `lastIndex` between calls.
	DECLARED_URL_RE.lastIndex = 0;
	let match = DECLARED_URL_RE.exec(clean);
	while (match !== null) {
		out.push(match[1].replace(/[.,;:!?]+$/, ""));
		match = DECLARED_URL_RE.exec(clean);
	}
	return out;
}

/**
 * Return the trailing partial line of a chunk — everything after the last
 * newline — capped so a pathological single-line stream (a progress bar
 * redrawing with `\r`) can't grow the carry buffer without bound.
 *
 * PTY output is split on arbitrary 4096-byte boundaries, so a marker line can
 * straddle two chunks. Carrying the partial line forward and re-scanning it
 * with the next chunk makes detection boundary-proof.
 */
export function trailingPartialLine(input: string, cap = 2048): string {
	const idx = input.lastIndexOf("\n");
	const tail = idx === -1 ? input : input.slice(idx + 1);
	return tail.length > cap ? tail.slice(-cap) : tail;
}

/**
 * Extract normalized dev-server URLs from a chunk of shell output. Returns
 * URLs in the order they appear. Caller is responsible for deduping across
 * chunks (use {@link dedupUrlKey}).
 */
export function extractLocalUrls(input: string): string[] {
	const clean = stripAnsi(input);
	const matches = clean.match(LOCAL_URL_RE) ?? [];
	return matches.map(normalizeUrl);
}

/**
 * Canonical key used for deduping URLs. Collapses by origin
 * (`scheme://host:port`) so that different paths hitting the same dev
 * server — e.g. banner `http://localhost:5173/` and request log
 * `http://localhost:5173/api/users` — represent the same service and
 * only show up once in the Open menu. http vs https and different ports
 * stay distinct. Falls back to trailing-slash strip for URLs we can't
 * parse an origin from (shouldn't happen given our match regex).
 */
export function dedupUrlKey(url: string): string {
	const origin = url.match(/^(https?:\/\/[^/?#]+)/i);
	return origin ? origin[1].toLowerCase() : url.replace(/\/+$/, "");
}

/**
 * Extract the port number from a URL. Returns null if the URL omits the
 * port (defaulting to 80/443 via scheme isn't useful for the Run button).
 */
export function extractPort(url: string): number | null {
	const match = url.match(/:(\d+)(?=\/|$|\?|#)/);
	return match ? Number(match[1]) : null;
}

function normalizeUrl(raw: string): string {
	// Strip trailing sentence punctuation that's clearly not URL syntax.
	const trimmed = raw.replace(/[.,;:!?]+$/, "");
	// Rewrite wildcard/loopback hosts to the name browsers are happiest with.
	return trimmed.replace(/127\.0\.0\.1|0\.0\.0\.0/, "localhost");
}
