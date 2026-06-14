import { useCallback, useState } from "react";
import {
	type AcceptInviteError,
	acceptInvite,
	InviteAcceptFailure,
	type TeamIdentity,
} from "@/lib/team-api";
import {
	clearInviteFromLocation,
	type ParsedInvite,
	saveTeamConfig,
	setTeamModeActive,
} from "@/lib/team-mode";

/** Human-readable copy for each accept-failure reason. Centralised so the
 * dialog and any future surface phrase 404 / 410 / 409 consistently. */
export const ACCEPT_ERROR_MESSAGES: Record<AcceptInviteError, string> = {
	unknown: "This invite link wasn't recognized. Ask for a fresh one.",
	expired: "This invite has expired. Ask for a fresh one.",
	claimed: "This invite has already been used.",
	network: "Couldn't reach the team backend. Check your connection.",
	server: "The team backend rejected the invite. Try again later.",
};

export type InviteAcceptStatus = "idle" | "accepting" | "error";

/** Outcome of an accept attempt. `error` carries the human-readable
 * message on failure (also mirrored into the hook's `errorMessage` state
 * for reactive rendering) so imperative callers don't have to wait for a
 * state flush to read it. */
export interface AcceptOutcome {
	ok: boolean;
	error: string | null;
}

export interface UseInviteAcceptResult {
	status: InviteAcceptStatus;
	/** Set when `status === "error"`; one of the {@link ACCEPT_ERROR_MESSAGES}. */
	errorMessage: string | null;
	/** Redeem `invite` with `identity`, then (on success) persist the
	 * config, switch into team mode, and reload so the IPC transport is
	 * rebuilt against the Worker. */
	accept: (
		invite: ParsedInvite,
		identity: TeamIdentity,
	) => Promise<AcceptOutcome>;
}

/**
 * Drive the invite → accept → activate-team-mode handshake. The token in the
 * link becomes the member's saved bearer (trust-on-first-use); on success we
 * `saveTeamConfig({ url, token })`, flip team mode on, and reload.
 *
 * Reload is the same mechanism the Team panel / sidebar switch already use
 * (`ipc.ts` resolves its transport synchronously at module load), so this
 * stays consistent with the Phase-0 design.
 */
export function useInviteAccept(): UseInviteAcceptResult {
	const [status, setStatus] = useState<InviteAcceptStatus>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const accept = useCallback(
		async (
			invite: ParsedInvite,
			identity: TeamIdentity,
		): Promise<AcceptOutcome> => {
			setStatus("accepting");
			setErrorMessage(null);
			try {
				await acceptInvite(invite.url, invite.token, identity);
				// Token doubles as the member's bearer — persist it and turn
				// the mode on, then drop the param so a reload can't replay it.
				saveTeamConfig({ url: invite.url, token: invite.token });
				setTeamModeActive(true);
				clearInviteFromLocation();
				window.location.reload();
				return { ok: true, error: null };
			} catch (error) {
				const reason: AcceptInviteError =
					error instanceof InviteAcceptFailure ? error.reason : "server";
				const message = ACCEPT_ERROR_MESSAGES[reason];
				setStatus("error");
				setErrorMessage(message);
				return { ok: false, error: message };
			}
		},
		[],
	);

	return { status, errorMessage, accept };
}
