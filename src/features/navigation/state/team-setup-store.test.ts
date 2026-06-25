import { describe, expect, it } from "vitest";
import { useTeamSetupStore } from "./team-setup-store";

describe("useTeamSetupStore", () => {
	it("requestSetup opens the card and close dismisses it", () => {
		useTeamSetupStore.getState().close();
		expect(useTeamSetupStore.getState().open).toBe(false);

		useTeamSetupStore.getState().requestSetup();
		expect(useTeamSetupStore.getState().open).toBe(true);

		useTeamSetupStore.getState().close();
		expect(useTeamSetupStore.getState().open).toBe(false);
	});
});
