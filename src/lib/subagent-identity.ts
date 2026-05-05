// Stable visual identity (nickname + color) for a Codex sub-agent thread.
// Both pools are keyed by threadId via FNV-1a hash. Color is ours; nickname
// prefers Codex's `thread/read` value and falls back to the pool when absent.

const NICKNAME_POOL = [
	"Hubble",
	"Curie",
	"Dewey",
	"Leibniz",
	"Pauli",
	"Atlas",
	"Echo",
	"Delta",
	"Newton",
	"Tesla",
	"Kepler",
	"Hopper",
	"Lovelace",
	"Turing",
	"Edison",
	"Galileo",
	"Bohr",
	"Faraday",
	"Maxwell",
	"Feynman",
	"Darwin",
	"Mendel",
	"Pasteur",
	"Planck",
	"Schrödinger",
	"Volta",
	"Watson",
	"Crick",
	"Heisenberg",
	"Rutherford",
	"Halley",
	"Chandrasekhar",
] as const;

// CSS vars defined in `src/styles/color-theme.css` (light + dark variants).
const COLOR_POOL = [
	"var(--subagent-1)",
	"var(--subagent-2)",
	"var(--subagent-3)",
	"var(--subagent-4)",
	"var(--subagent-5)",
	"var(--subagent-6)",
] as const;

export interface SubagentIdentity {
	/** Display label. Either Codex-provided (preferred) or pool fallback. */
	nickname: string;
	/** True iff `nickname` came from our pool, not Codex. Useful for
	 *  diagnostics; intentionally not surfaced in the UI. */
	nicknameIsFallback: boolean;
	/** A `var(--subagent-N)` reference. Apply via inline `style.color`. */
	color: string;
}

// 32-bit FNV-1a. Stable, uniform-ish; pool collisions are fine.
function fnv1a(input: string): number {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash = (hash ^ input.charCodeAt(i)) * 16777619;
		hash >>>= 0;
	}
	return hash;
}

export function getSubagentIdentity(
	threadId: string,
	providedNickname: string | null | undefined,
): SubagentIdentity {
	const hash = fnv1a(threadId);
	const trimmedProvided =
		typeof providedNickname === "string" ? providedNickname.trim() : "";
	const hasProvided = trimmedProvided.length > 0;

	// Independent indices so a Codex-provided nickname doesn't shift the color.
	const nicknameIdx = hash % NICKNAME_POOL.length;
	const colorIdx = (hash >>> 8) % COLOR_POOL.length;

	return {
		nickname: hasProvided ? trimmedProvided : NICKNAME_POOL[nicknameIdx]!,
		nicknameIsFallback: !hasProvided,
		color: COLOR_POOL[colorIdx]!,
	};
}

// Exported for tests only.
export const __SUBAGENT_IDENTITY_INTERNALS = {
	NICKNAME_POOL,
	COLOR_POOL,
	fnv1a,
};
