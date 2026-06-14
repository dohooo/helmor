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
	/** Workspace linked directories (composer /add-dir). claude maps them to
	 *  `--add-dir`; codex ignores them (danger-full-access reaches them
	 *  anyway). Snapshot at launch — TUIs can't take new dirs mid-run. */
	addDirs?: readonly string[] | null;
	/** codex maps this to `-c service_tier="fast"`; claude's equivalent rides
	 *  the backend-injected --settings file instead (no CLI flag). */
	fastMode?: boolean;
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
	 *  null = the CLI has no resume. `prompt`, when set, rides along as the
	 *  resumed turn's initial input (composer convert-in-place → TUI). */
	resume(
		providerSessionId: string,
		opts?: { addDirs?: readonly string[] | null; prompt?: string | null },
	): string | null;
};

/** POSIX single-quote a value so untrusted text (session ids, prompts) can't
 * inject shell syntax when spliced into the interactive boot command. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote the user prompt for the boot command. A multi-line prompt single-
 * quoted with literal newlines makes the boot command span multiple physical
 * lines; the interactive shell's line editor then submits at the first newline
 * (dangling quote → `quote>`, the CLI never launches) and a literal tab fires
 * completion. When the prompt has those control chars, use `$'...'` ANSI-C
 * quoting so the command stays one physical line and the shell rebuilds the
 * real newlines/tabs in the CLI's argv. zsh/bash both support it (the boot
 * prefix already requires one via `export VAR=...;`). */
function shellQuotePrompt(value: string): string {
	if (!/[\n\r\t]/.test(value)) return shellQuote(value);
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll("'", "\\'")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
	return `$'${escaped}'`;
}

/** Empty/whitespace model id → no `--model` flag (the CLI falls back to its
 * own default). Every catalog model is a real wire id, so nothing to strip. */
function cliModelOrNull(modelId?: string | null): string | null {
	return modelId?.trim() || null;
}

function claudeAddDirFlags(addDirs?: readonly string[] | null): string[] {
	const parts: string[] = [];
	for (const dir of addDirs ?? []) {
		const trimmed = dir.trim();
		if (trimmed) parts.push("--add-dir", shellQuote(trimmed));
	}
	return parts;
}

const CLAUDE_SPEC: TerminalAgentSpec = {
	key: "claude",
	presetCommand: "claude --dangerously-skip-permissions",
	boot(opts) {
		const parts = ["claude"];
		const model = cliModelOrNull(opts.modelId);
		const effort = opts.effortLevel?.trim();
		const permission = opts.permissionMode?.trim();
		if (model) parts.push("--model", shellQuote(model));
		if (effort) parts.push("--effort", shellQuote(effort));
		if (permission) parts.push("--permission-mode", shellQuote(permission));
		parts.push(...claudeAddDirFlags(opts.addDirs));
		parts.push(shellQuotePrompt(opts.prompt));
		return parts.join(" ");
	},
	resume(id, opts) {
		// --add-dir is a process-level grant, so a resumed session needs the
		// workspace's linked directories re-passed too.
		const parts = [
			"claude",
			"--resume",
			shellQuote(id),
			"--dangerously-skip-permissions",
			...claudeAddDirFlags(opts?.addDirs),
		];
		// `claude [options] [prompt]` — a trailing positional prompt runs as the
		// first turn of the resumed conversation.
		if (opts?.prompt?.trim()) parts.push(shellQuotePrompt(opts.prompt));
		return parts.join(" ");
	},
};

const CODEX_SPEC: TerminalAgentSpec = {
	key: "codex",
	presetCommand:
		'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
	boot(opts) {
		const parts = ["codex"];
		const model = cliModelOrNull(opts.modelId);
		const effort = opts.effortLevel?.trim();
		if (model) parts.push("-m", shellQuote(model));
		if (effort) {
			parts.push("-c", shellQuote(`model_reasoning_effort="${effort}"`));
		}
		if (opts.fastMode) {
			// Best-effort: the SDK requests fast via the app-server turn param
			// `serviceTier: "fast"`; the TUI has no documented flag, so pass
			// the matching config key and verify on-device.
			parts.push("-c", shellQuote('service_tier="fast"'));
		}
		if (opts.permissionMode?.trim() === "bypassPermissions") {
			parts.push(
				"--ask-for-approval",
				"never",
				"--sandbox",
				"danger-full-access",
			);
		}
		parts.push(shellQuotePrompt(opts.prompt));
		return parts.join(" ");
	},
	resume(id, opts) {
		// `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` — the trailing prompt
		// starts the resumed session with the composer's input.
		const base = `codex resume ${shellQuote(id)} -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access`;
		return opts?.prompt?.trim()
			? `${base} ${shellQuotePrompt(opts.prompt)}`
			: base;
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
	opts?: { addDirs?: readonly string[] | null; prompt?: string | null },
): string | null {
	const invocation = findTerminalAgent(key)?.resume(sessionId, opts);
	return invocation ? `${invocation}\n` : null;
}
