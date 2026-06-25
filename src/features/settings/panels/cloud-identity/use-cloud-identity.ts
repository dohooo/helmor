import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authorizeCloudCodexIdentity } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type CloudCodexIdentityStatus,
	getCloudCodexIdentityStatus,
} from "@/lib/team-api";
import { getTeamConfig, type TeamConfig } from "@/lib/team-mode";

/**
 * State + actions for the "Cloud Run Identity · Codex" settings panel.
 *
 * Reads the cloud identity status from the team control plane (the Worker's
 * `GET /team/cloud-identity` → the member's `CodexIdentity` Durable Object
 * `status()`), and drives the one-time `Authorize` flow through the local
 * Rust command (`authorize_cloud_codex_identity`), which runs `codex login`
 * in a throwaway 0700 CODEX_HOME, reads the OAuth `refresh_token` +
 * `id_token`, and uploads them to that member's DO over the team bearer.
 *
 * The status never carries the `refresh_token` (the DO's `status()` returns
 * only `{hasToken, accountId, accessExp, bricked}`), so nothing secret ever
 * reaches the frontend. After a successful authorize we invalidate the status
 * query so the panel re-fetches the freshly-bound identity.
 *
 * `cfg` is the resolved team backend config — the caller (the outer panel)
 * gates on team mode and passes `null` in single-user mode, which disables
 * the status query so this hook stays inert outside team mode.
 */
export interface UseCloudIdentity {
	status: CloudCodexIdentityStatus | undefined;
	/** First status fetch in flight (no cached value yet). */
	isLoading: boolean;
	/** Status fetch failed (couldn't reach the control plane). */
	isError: boolean;
	/** The local `codex login` → upload round-trip is running. */
	isAuthorizing: boolean;
	/** Human-readable error from the authorize round-trip, or `null`. */
	error: string | null;
	/**
	 * True when the cloud identity exists but can no longer authenticate and
	 * the user must re-run authorize: either the DO marked it `bricked`
	 * (refresh failed / RT lost) or its access token has already expired.
	 * Framed as a needs-action state (Phase-5 reconnect semantics), not an
	 * error — the recovery is the same Authorize button.
	 */
	needsReauthorize: boolean;
	authorize: () => void;
	refetch: () => void;
}

/**
 * True once an access token's expiry is in the past. `accessExp` is a unix
 * epoch in seconds (the JWT `exp` claim the DO surfaces); a null/absent value
 * means "no token yet", which is not an expiry.
 */
export function isCloudIdentityExpired(
	status: CloudCodexIdentityStatus | undefined,
): boolean {
	if (!status?.hasToken || status.accessExp == null) return false;
	return status.accessExp * 1000 <= Date.now();
}

/** The "no identity bound" shape — only ever returned on the disabled
 *  branch (cfg null), which `enabled` prevents from running anyway. */
const EMPTY_STATUS: CloudCodexIdentityStatus = {
	hasToken: false,
	accountId: null,
	accessExp: null,
	bricked: false,
};

export function useCloudIdentity(cfg: TeamConfig | null): UseCloudIdentity {
	const queryClient = useQueryClient();

	const statusQuery = useQuery<CloudCodexIdentityStatus>({
		// Keyed by Worker URL so switching backends never serves a stale
		// identity. Not persisted — remote + per-session, like the other
		// team control-plane reads.
		queryKey: helmorQueryKeys.cloudCodexIdentity(cfg?.url ?? "__none__"),
		queryFn: () => {
			// `enabled` keeps this off when cfg is null; the resolve here only
			// satisfies the type — it never runs while disabled.
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) return Promise.resolve(EMPTY_STATUS);
			return getCloudCodexIdentityStatus(resolved);
		},
		enabled: cfg !== null,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		retry: 1,
	});

	const authorizeMutation = useMutation({
		// The Rust command can't read the webview's localStorage, so forward the
		// resolved team Worker URL + bearer (the RT travels frontend → Rust →
		// Worker; it never comes back). `cfg` is non-null whenever this mutation
		// can fire (the panel only mounts the content under team mode); fall back
		// to `getTeamConfig()` to satisfy the type for the null branch.
		mutationFn: () => {
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) {
				return Promise.reject(new Error("Team mode is not configured."));
			}
			return authorizeCloudCodexIdentity(resolved.url, resolved.token);
		},
		// On success (and on failure — a partial run may still have changed
		// state) re-read the identity so the panel reflects the live DO.
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.cloudCodexIdentity(cfg?.url ?? "__none__"),
			});
		},
	});

	const status = statusQuery.data;

	return {
		status,
		isLoading: statusQuery.isLoading,
		isError: statusQuery.isError,
		isAuthorizing: authorizeMutation.isPending,
		error:
			authorizeMutation.error instanceof Error
				? authorizeMutation.error.message
				: authorizeMutation.error
					? String(authorizeMutation.error)
					: null,
		needsReauthorize:
			(status?.bricked ?? false) || isCloudIdentityExpired(status),
		authorize: () => authorizeMutation.mutate(),
		refetch: () => {
			void statusQuery.refetch();
		},
	};
}
