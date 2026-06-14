// Test-only Worker entrypoint for the CodexIdentity DO unit suite.
//
// The vitest-pool-workers pool needs a `main` Worker whose module graph
// declares the Durable Object classes under test. We point it here (instead of
// the real `src/index.ts`) so the test isolate doesn't pull in the
// `@cloudflare/sandbox` container DO, the R2 / D1 bindings, or the `[[containers]]`
// image — none of which are needed to exercise the broker DO, and all of which
// are awkward to stand up under miniflare. Only the broker DOs are re-exported.

export { ClaudeIdentity } from "../src/claude-identity";
export { CodexIdentity } from "../src/codex-identity";

// A no-op default fetch handler keeps the Worker valid; the tests drive the DO
// directly via `runInDurableObject`, never through this fetch.
export default {
	fetch(): Response {
		return new Response("ok");
	},
};
