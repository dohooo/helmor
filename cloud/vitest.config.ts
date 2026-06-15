import {
	cloudflarePool,
	cloudflareTest,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run the CodexIdentity DO suite INSIDE workerd (via @cloudflare/vitest-pool-
// workers + miniflare) so it exercises the real Durable Object storage and the
// real WebCrypto `crypto.subtle` AES-GCM — the two primitives the broker's
// security guarantees rest on. A plain jsdom/node run would mock both away.
//
// Vitest 4 wiring: the pool is a `cloudflareTest(...)` Vite plugin plus a
// `cloudflarePool(...)` runner on `test.poolRunner` (this build doesn't
// re-export `defineWorkersConfig`, which would assemble these for us). Options
// are top-level (`main`/`miniflare`/`isolatedStorage`/`singleWorker`), per the
// Vitest 4 pool rework.
//
// `main` points at a TEST-ONLY worker entry that re-exports just
// `CodexIdentity` — keeping the `@cloudflare/sandbox` container DO, R2, and D1
// bindings (and the Docker `[[containers]]` image) out of the test isolate,
// none of which the broker DO needs.
const workersOptions = {
	main: "./test/codex-identity-worker.ts",
	// Per-test isolated storage so each test gets a clean DO.
	isolatedStorage: true,
	singleWorker: true,
	miniflare: {
		compatibilityDate: "2026-06-09",
		compatibilityFlags: ["nodejs_compat"],
		// The DO bindings under test. Each class lives in the `main` worker's
		// module graph (re-exported there).
		durableObjects: {
			CODEX_IDENTITY: { className: "CodexIdentity" },
			CLAUDE_IDENTITY: { className: "ClaudeIdentity" },
		},
		// A 32-byte AES key, base64-encoded, for the DO's at-rest crypto.
		// Deterministic so encrypt/decrypt round-trips are reproducible.
		bindings: {
			BROKER_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			// The DO refreshes against this in tests; every test stubs `fetch`
			// to answer it, so an unstubbed / stray call is loud.
			CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://oauth.test.invalid/token",
		},
		// In-memory D1 for the team-registry tests (handleTeamClone's workspaces
		// mirror write). The schema is applied per-suite (see team-clone.test.ts).
		d1Databases: { DB: "helmor-team-test" },
	},
};

export default defineConfig({
	plugins: [cloudflareTest(workersOptions)],
	test: {
		include: ["test/**/*.test.ts"],
		// @ts-expect-error vitest-pool-workers 0.16 + Vitest 4: `poolRunner` is the
		// correct runtime field for this build (it does not export
		// `defineWorkersConfig`), but Vitest 4's InlineConfig type does not declare it.
		poolRunner: cloudflarePool(workersOptions),
	},
});
