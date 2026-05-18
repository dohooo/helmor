/**
 * On-demand ISR revalidation webhook for the marketing site.
 *
 * Triggered by `.github/workflows/refresh-marketing.yml` on GitHub Release
 * `published` events, so helmor.ai reflects new versions within seconds
 * instead of waiting for the hourly `revalidate: 3600` window in
 * `app/page.tsx` + `lib/github.ts`.
 *
 * Security:
 *   - Shared secret `HELMOR_MARKETING_REVALIDATE_SECRET` must match on both
 *     sides (Vercel env var + GitHub Actions secret).
 *   - Secret is read from the `x-revalidate-secret` HEADER (never query
 *     string), compared via `crypto.timingSafeEqual` to avoid timing attacks.
 *   - Fail-closed: if the env var is missing, we return 500 rather than
 *     silently allowing unauthenticated revalidation.
 *
 * Failure mode: if this route ever breaks, the existing 3600s ISR in
 * `app/page.tsx` still auto-refreshes the page. Worst case is ~1 hour stale.
 */

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

// `crypto.timingSafeEqual` needs Node runtime. Default is Node in Next 15
// App Router, but declare it explicitly so future regressions surface.
export const runtime = "nodejs";
// The route itself must not be cached -- every hit is a control-plane call.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
	const expected = process.env.HELMOR_MARKETING_REVALIDATE_SECRET;
	if (!expected) {
		return NextResponse.json(
			{ ok: false, error: "not_configured" },
			{ status: 500 },
		);
	}

	const provided = req.headers.get("x-revalidate-secret") ?? "";
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
		return NextResponse.json({ ok: false }, { status: 401 });
	}

	try {
		// Only the home page pulls from GitHub. Scope = "page" avoids
		// invalidating layouts we don't own.
		revalidatePath("/", "page");
		return NextResponse.json({ ok: true, revalidated: "/" });
	} catch {
		return NextResponse.json(
			{ ok: false, error: "revalidate_failed" },
			{ status: 500 },
		);
	}
}
