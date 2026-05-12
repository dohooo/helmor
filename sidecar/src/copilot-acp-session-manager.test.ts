import { expect, test } from "bun:test";
import { COPILOT_ACP_ARGS } from "./copilot-acp-session-manager.js";

test("Copilot ACP uses the supported top-level --acp flag", () => {
	expect(COPILOT_ACP_ARGS).toEqual(["--acp"]);
});
