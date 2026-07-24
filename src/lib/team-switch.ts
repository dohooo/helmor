/**
 * The in-place team-mode switch action.
 *
 * Split out from `team-mode.ts` to avoid a LOAD-TIME circular dependency:
 * `ipc.ts` eagerly reads {@link isTeamModeActive} in its module-init `transport`
 * IIFE, so `team-mode.ts` must not import `ipc.ts` at the top level — doing so
 * would force `ipc.ts` to evaluate while `team-mode.ts` is still initializing,
 * hitting `team-mode.ts`'s consts in their temporal dead zone. This module sits
 * one layer up: it imports `ipc.ts`, `team-mode.ts`, and `transport-generation.ts`,
 * and none of those import it back — so there is no cycle. The dependency edge is
 * one-way (`team-switch → ipc → team-mode`), which initializes cleanly in any
 * import order.
 */

import { applyTransportSwitch } from "./ipc";
import {
	saveTeamConfig,
	setTeamModeActive,
	type TeamConfig,
} from "./team-mode";
import { beginTeamReadinessProbe, resetTeamReadiness } from "./team-readiness";
import { bumpTransportGeneration } from "./transport-generation";

/**
 * Switch between Local and Team IN PLACE — no `window.location.reload`.
 *
 *   switchTeamMode({ url, token })  → save config, activate team mode, repoint
 *   switchTeamMode(null)            → deactivate team mode, repoint to local
 *
 * Order matters:
 *   1. Persist config + flip the mode flag, so `applyTransportSwitch`'s
 *      `recomputeTransportMode` reads the new truth.
 *   2. `applyTransportSwitch()` — tear down the old SSE loop + companion
 *      listeners, recompute the transport, and seed the connecting state so the
 *      shell shows the loading banner immediately when entering a remote
 *      transport (the new Worker is cold).
 *   3. `bumpTransportGeneration()` — remount the app subtree against the new
 *      transport. The QueryClient is recreated on generation change (fresh,
 *      empty cache — no cross-backend data bleed; see `use-app-bootstrap.ts`),
 *      and the generation effect in `app-providers.tsx` resets the router + the
 *      module-level streaming store so no stale workspace/session id from the
 *      old backend survives the swap.
 */
export function switchTeamMode(config: TeamConfig | null): void {
	if (config) {
		saveTeamConfig(config);
		setTeamModeActive(true);
	} else {
		setTeamModeActive(false);
	}
	applyTransportSwitch();
	bumpTransportGeneration();
	// WP1: entering Team always runs the readiness probe (health → ready |
	// degraded); leaving Team stops it. Every team gate derives from the
	// resulting `useTeamReadiness()` — no more stale-config "instant connect".
	if (config) {
		beginTeamReadinessProbe();
	} else {
		resetTeamReadiness();
	}
}
