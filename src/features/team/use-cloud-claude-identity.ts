import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authorizeCloudClaudeIdentity } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type CloudClaudeIdentityStatus,
	getCloudClaudeIdentityStatus,
} from "@/lib/team-api";
import { getTeamConfig, type TeamConfig } from "@/lib/team-mode";

/**
 * State + actions for the "Cloud Run Identity · Claude" settings panel.
 *
 * Reads the cloud Claude identity status from the team control plane (the
 * Worker's `GET /team/claude-identity` → the member's `ClaudeIdentity` Durable
 * Object `status()`), and drives the one-time `Authorize` flow through the local
 * Rust command (`authorize_cloud_claude_identity`), which drives our own Claude
 * OAuth (PKCE) flow (opening the browser + awaiting the loopback `/callback` +
 * code→token exchange), captures the long-lived
 * `CLAUDE_CODE_OAUTH_TOKEN`, and uploads it to that member's DO over the team
 * bearer.
 *
 * The Claude credential is self-contained and inference-only (no refresh, no
 * JWT, no account claim — see claude-cloud-auth-VERIFIED.md §1.7), so status is
 * `{ hasToken }` only, and the token never reaches the frontend. After a
 * successful authorize we invalidate the status query so the panel re-fetches
 * the freshly-bound identity.
 *
 * `cfg` is the resolved team backend config — the caller (the outer panel)
 * gates on team mode and passes `null` in single-user mode, which disables the
 * status query so this hook stays inert outside team mode.
 */
export interface UseCloudClaudeIdentity {
	status: CloudClaudeIdentityStatus | undefined;
	/** First status fetch in flight (no cached value yet). */
	isLoading: boolean;
	/** Status fetch failed (couldn't reach the control plane). */
	isError: boolean;
	/** The local OAuth (PKCE) → upload round-trip is running. */
	isAuthorizing: boolean;
	/** Human-readable error from the authorize round-trip, or `null`. */
	error: string | null;
	authorize: () => void;
	refetch: () => void;
}

/** The "no identity bound" shape — only ever returned on the disabled branch
 *  (cfg null), which `enabled` prevents from running anyway. */
const EMPTY_STATUS: CloudClaudeIdentityStatus = {
	hasToken: false,
};

export function useCloudClaudeIdentity(
	cfg: TeamConfig | null,
): UseCloudClaudeIdentity {
	const queryClient = useQueryClient();

	const statusQuery = useQuery<CloudClaudeIdentityStatus>({
		// Keyed by Worker URL so switching backends never serves a stale
		// identity. Not persisted — remote + per-session, like the other team
		// control-plane reads.
		queryKey: helmorQueryKeys.cloudClaudeIdentity(cfg?.url ?? "__none__"),
		queryFn: () => {
			// `enabled` keeps this off when cfg is null; the resolve here only
			// satisfies the type — it never runs while disabled.
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) return Promise.resolve(EMPTY_STATUS);
			return getCloudClaudeIdentityStatus(resolved);
		},
		enabled: cfg !== null,
		staleTime: 30_000,
		refetchOnWindowFocus: true,
		retry: 1,
	});

	const authorizeMutation = useMutation({
		// The Rust command can't read the webview's localStorage, so forward the
		// resolved team Worker URL + bearer (the token travels frontend → Rust →
		// Worker; it never comes back). `cfg` is non-null whenever this mutation
		// can fire (the panel only mounts the content under team mode); fall back
		// to `getTeamConfig()` to satisfy the type for the null branch.
		mutationFn: () => {
			const resolved = cfg ?? getTeamConfig();
			if (!resolved) {
				return Promise.reject(new Error("Team mode is not configured."));
			}
			return authorizeCloudClaudeIdentity(resolved.url, resolved.token);
		},
		// On success (and on failure — a partial run may still have changed
		// state) re-read the identity so the panel reflects the live DO.
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.cloudClaudeIdentity(cfg?.url ?? "__none__"),
			});
		},
	});

	return {
		status: statusQuery.data,
		isLoading: statusQuery.isLoading,
		isError: statusQuery.isError,
		isAuthorizing: authorizeMutation.isPending,
		error:
			authorizeMutation.error instanceof Error
				? authorizeMutation.error.message
				: authorizeMutation.error
					? String(authorizeMutation.error)
					: null,
		authorize: () => authorizeMutation.mutate(),
		refetch: () => {
			void statusQuery.refetch();
		},
	};
}
