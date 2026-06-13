// MiMo Code's instantiation of the opencode-protocol family. MiMo Code
// (XiaomiMiMo/MiMo-Code, npm `@mimo-ai/cli`) is a whole-tree fork of opencode
// that keeps the server/SDK protocol intact and renames the surface:
// binary `mimo`, env vars MIMOCODE_*, basic-auth user `mimocode`, banner
// "mimocode server listening". Verified against @mimo-ai/cli 0.1.0.

import type { ProtocolServerConfig } from "./server.js";
import type { ProtocolManagerConfig } from "./session-manager.js";

export const MIMO_SERVER_CONFIG: ProtocolServerConfig = {
	id: "mimo",
	readyPrefix: "mimocode server listening",
	binEnvVar: "HELMOR_MIMO_BIN_PATH",
	platformPkg: (s) => `@mimo-ai/mimocode-${s}`,
	binName: "mimo",
	passwordEnvVar: "MIMOCODE_SERVER_PASSWORD",
	dbEnvVar: "MIMOCODE_DB",
	authUsername: "mimocode",
};

export const MIMO_PROTOCOL_CONFIG: ProtocolManagerConfig = {
	provider: "mimo",
	permissionPrefix: "mimo-",
	sourceBadge: "MiMo Code",
	server: MIMO_SERVER_CONFIG,
};
