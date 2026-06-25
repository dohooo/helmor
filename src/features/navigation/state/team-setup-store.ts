import { create } from "zustand";

/**
 * Transient UI state for the team-cloud setup surface. When the user picks
 * "Team" from the workspace-location switch but has no backend configured yet,
 * we open the setup card (Join / Create) over a frosted overlay instead of
 * dumping them into raw Settings fields. Not persisted — it's a one-shot
 * "the user wants to set up team cloud right now" flag.
 */
interface TeamSetupState {
	open: boolean;
	/** Show the Join / Create setup card. */
	requestSetup: () => void;
	/** Dismiss the card (joined, created, or cancelled). */
	close: () => void;
}

export const useTeamSetupStore = create<TeamSetupState>((set) => ({
	open: false,
	requestSetup: () => set({ open: true }),
	close: () => set({ open: false }),
}));
