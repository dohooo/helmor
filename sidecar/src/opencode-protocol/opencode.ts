// opencode's instantiation of the opencode-protocol family. Shared machinery
// lives in `server.ts` / `session-manager.ts`.

import type { ProtocolServerConfig } from "./server.js";
import type { ProtocolManagerConfig } from "./session-manager.js";

export const OPENCODE_SERVER_CONFIG: ProtocolServerConfig = {
	id: "opencode",
	readyPrefix: "opencode server listening",
	binEnvVar: "HELMOR_OPENCODE_BIN_PATH",
	platformPkg: (s) => `opencode-${s}`,
	binName: "opencode",
	passwordEnvVar: "OPENCODE_SERVER_PASSWORD",
	dbEnvVar: "OPENCODE_DB",
	authUsername: "opencode",
};

export const OPENCODE_PROTOCOL_CONFIG: ProtocolManagerConfig = {
	provider: "opencode",
	permissionPrefix: "opencode-",
	sourceBadge: "OpenCode",
	server: OPENCODE_SERVER_CONFIG,
};
