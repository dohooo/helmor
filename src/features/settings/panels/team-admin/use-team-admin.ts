import { useMutation } from "@tanstack/react-query";
import { createTeam, mintInvite } from "@/lib/team-api";
import { getTeamConfig, type TeamConfig } from "@/lib/team-mode";

/**
 * State + actions for the "Team admin" settings panel (Preview A).
 *
 * Drives the two admin-only control-plane writes — bootstrap the single team
 * (`POST /team/bootstrap`) and mint an invite (`POST /team/invite`) — over the
 * team bearer. Both routes are admin-gated server-side: a 401 means the saved
 * token isn't the companion/admin token, which the wrappers phrase explicitly.
 *
 * Write-only by design — there is NO status GET here (mirrors the cloud-identity
 * hook's mutation half, minus its read query). The minted invite URL is a
 * capability secret: it lives only in `mintInvite.data` after an explicit Mint
 * and is never auto-fetched or logged.
 *
 * `cfg` is the resolved team backend config — the caller (the outer panel) gates
 * on team mode and passes `null` in single-user mode, so both mutations reject
 * cleanly and this hook stays inert outside team mode.
 */
export function useTeamAdmin(cfg: TeamConfig | null) {
	const createTeamMutation = useMutation({
		mutationFn: () => {
			// `cfg` is non-null whenever this can fire (the panel only mounts the
			// content under team mode); fall back to `getTeamConfig()` to satisfy
			// the type for the null branch.
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) {
				return Promise.reject(new Error("Team mode is not configured."));
			}
			return createTeam(resolved);
		},
	});

	const mintInviteMutation = useMutation({
		mutationFn: () => {
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) {
				return Promise.reject(new Error("Team mode is not configured."));
			}
			return mintInvite(resolved);
		},
	});

	return { createTeam: createTeamMutation, mintInvite: mintInviteMutation };
}
