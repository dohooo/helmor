import { useEffect, useState } from "react";
import {
	getScriptState,
	type ScriptStatus,
	subscribeStatus,
} from "../script-store";

/**
 * Condensed per-tab status label used to choose which status icon to render
 * next to the Setup / Run tab text.
 *
 * - `no-script`  — repository has no script configured for this slot
 * - `idle`       — script configured but has not run in this workspace yet
 * - `running`    — script currently executing
 * - `success`    — last run exited cleanly (exit code 0)
 * - `failure`    — last run crashed or exited non-zero
 */
export type ScriptIconState =
	| "no-script"
	| "idle"
	| "running"
	| "success"
	| "failure";

function deriveState(
	hasScript: boolean,
	status: ScriptStatus,
	exitCode: number | null,
): ScriptIconState {
	if (!hasScript) return "no-script";
	if (status === "running") return "running";
	if (status === "exited") return exitCode === 0 ? "success" : "failure";
	return "idle";
}

/**
 * Subscribes to the shared script-store for live status of a script slot
 * (setup / run) in a given workspace. Returns a state label suitable for
 * driving the small status icon next to each tab label.
 *
 * For "run" scripts, `actionId` selects which run-action's status to mirror
 * — typically the workspace's active action. Pass `null` for "setup".
 *
 * `lastCompletedAt` lets the caller restore the success badge across app
 * restarts: when there's no live in-memory entry but the workspace has a
 * persisted completion timestamp, treat the slot as `success`.
 */
export function useScriptStatus(
	workspaceId: string | null,
	scriptType: "setup" | "run",
	hasScript: boolean,
	actionId: string | null = null,
	lastCompletedAt: string | null = null,
): ScriptIconState {
	const [status, setStatus] = useState<ScriptStatus>("idle");
	const [exitCode, setExitCode] = useState<number | null>(null);

	useEffect(() => {
		if (!workspaceId) {
			setStatus("idle");
			setExitCode(null);
			return;
		}
		// "run" without a resolved actionId means "no action selected yet"
		// — treat as idle and skip the subscription rather than fall back
		// to a stale entry from a previously-selected action.
		if (scriptType === "run" && !actionId) {
			setStatus("idle");
			setExitCode(null);
			return;
		}

		// Seed from whatever is already running / previously exited, so the
		// icon is correct even when mounted after the run started.
		const existing = getScriptState(workspaceId, scriptType, actionId);
		setStatus(existing?.status ?? "idle");
		setExitCode(existing?.exitCode ?? null);

		return subscribeStatus(
			workspaceId,
			scriptType,
			(next, code) => {
				setStatus(next);
				setExitCode(code);
			},
			actionId,
		);
	}, [workspaceId, scriptType, actionId]);

	const state = deriveState(hasScript, status, exitCode);
	// Restore the success badge after restart: in-memory entry is gone but
	// the workspace row still has a completion timestamp.
	if (state === "idle" && lastCompletedAt) return "success";
	return state;
}
