// Per-agent terminal integration specs.
//
// Layering: everything platform-NEUTRAL (PTY spawn, output scheduling, the
// alt-screen boot gate, busy registry, hook prompt capture) lives in the
// store / backend and is shared. What differs per agent CLI is exactly how
// to INVOKE it — fresh boot flags, resume syntax, bare launch — and that's
// all a spec carries. Adding a terminal agent = adding one spec here (plus,
// for status-sync/resume, a hook-injection arm in terminal_commands.rs).

export type TerminalBootOptions = {
	prompt: string;
	modelId?: string | null;
	effortLevel?: string | null;
	permissionMode?: string | null;
};

export type TerminalAgentSpec = {
	/** sessions.agent_type value; also the composer provider it serves. */
	key: string;
	/** Bare interactive launch — the panel fallback when there is no
	 *  resume id and no composer prompt. "" = bare shell. */
	presetCommand: string;
	/** Fresh TUI start carrying composer state + the prompt as the initial
	 *  input (every supported CLI accepts a positional/flag prompt and
	 *  begins the turn immediately). */
	boot(opts: TerminalBootOptions): string;
	/** Resume a prior conversation by the agent's own session id;
	 *  null = the CLI has no resume. */
	resume(providerSessionId: string): string | null;
};

/** POSIX single-quote a value so untrusted text (session ids, prompts) can't
 * inject shell syntax when spliced into the interactive boot command. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const CLAUDE_SPEC: TerminalAgentSpec = {
	key: "claude",
	presetCommand: "claude --dangerously-skip-permissions",
	boot(opts) {
		const parts = ["claude"];
		const model = opts.modelId?.trim();
		const effort = opts.effortLevel?.trim();
		const permission = opts.permissionMode?.trim();
		if (model) parts.push("--model", shellQuote(model));
		if (effort) parts.push("--effort", shellQuote(effort));
		if (permission) parts.push("--permission-mode", shellQuote(permission));
		parts.push(shellQuote(opts.prompt));
		return parts.join(" ");
	},
	resume(id) {
		return `claude --resume ${shellQuote(id)} --dangerously-skip-permissions`;
	},
};

const CODEX_SPEC: TerminalAgentSpec = {
	key: "codex",
	presetCommand:
		'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
	boot(opts) {
		const parts = ["codex"];
		const model = opts.modelId?.trim();
		const effort = opts.effortLevel?.trim();
		if (model) parts.push("-m", shellQuote(model));
		if (effort) {
			parts.push("-c", shellQuote(`model_reasoning_effort="${effort}"`));
		}
		if (opts.permissionMode?.trim() === "bypassPermissions") {
			parts.push(
				"--ask-for-approval",
				"never",
				"--sandbox",
				"danger-full-access",
			);
		}
		parts.push(shellQuote(opts.prompt));
		return parts.join(" ");
	},
	resume(id) {
		return `codex resume ${shellQuote(id)} -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access`;
	},
};

// Supported terminal agents: Claude and Codex only.
const TERMINAL_AGENTS: readonly TerminalAgentSpec[] = [CLAUDE_SPEC, CODEX_SPEC];

/** Spec for an agent key / composer provider; null = no terminal support
 * (cursor/opencode have no spec — the composer toggle hides itself). */
export function findTerminalAgent(
	key: string | null | undefined,
): TerminalAgentSpec | null {
	if (!key) return null;
	return TERMINAL_AGENTS.find((spec) => spec.key === key) ?? null;
}

/** Bare-launch boot command for the panel fallback (null = bare shell). */
export function presetBootCommand(
	key: string | null | undefined,
): string | null {
	const spec = findTerminalAgent(key);
	if (!spec || spec.presetCommand.length === 0) return null;
	return `${spec.presetCommand}\n`;
}

/** Boot command for a composer-initiated Terminal session. Null =
 * unsupported provider. */
export function buildTerminalBootCommand(
	provider: string,
	opts: TerminalBootOptions,
): string | null {
	const spec = findTerminalAgent(provider);
	if (!spec) return null;
	return `${spec.boot(opts)}\n`;
}

/** Boot command resuming the agent's prior session (null = can't resume →
 * the caller falls back to a fresh preset). */
export function resumeBootCommand(
	key: string | null | undefined,
	sessionId: string,
): string | null {
	const invocation = findTerminalAgent(key)?.resume(sessionId);
	return invocation ? `${invocation}\n` : null;
}
