import { afterEach, describe, expect, test } from "bun:test";
import { parseProvider } from "../request-parser.js";
import { MIMO_PROTOCOL_CONFIG, MIMO_SERVER_CONFIG } from "./mimo.js";
import { OPENCODE_PROTOCOL_CONFIG } from "./opencode.js";
import { parseServerUrl, resolveBinPath } from "./server.js";

describe("mimo protocol config", () => {
	test("parses the mimocode ready banner", () => {
		expect(
			parseServerUrl(
				"Performing one time database migration, may take a few minutes...\nmimocode server listening on http://127.0.0.1:39271\n",
				MIMO_SERVER_CONFIG.readyPrefix,
			),
		).toBe("http://127.0.0.1:39271");
	});

	test("does NOT match the opencode banner (and vice versa)", () => {
		const opencodeBanner = "opencode server listening on http://127.0.0.1:4096";
		const mimoBanner = "mimocode server listening on http://127.0.0.1:4096";
		expect(parseServerUrl(opencodeBanner, MIMO_SERVER_CONFIG.readyPrefix)).toBe(
			null,
		);
		expect(
			parseServerUrl(mimoBanner, OPENCODE_PROTOCOL_CONFIG.server.readyPrefix),
		).toBe(null);
	});

	test("permission prefix routes distinctly from opencode", () => {
		expect(MIMO_PROTOCOL_CONFIG.permissionPrefix).toBe("mimo-");
		expect(
			MIMO_PROTOCOL_CONFIG.permissionPrefix ===
				OPENCODE_PROTOCOL_CONFIG.permissionPrefix,
		).toBe(false);
		// `opencode-…` ids must never match the `mimo-` startsWith branch.
		expect(
			"opencode-abc".startsWith(MIMO_PROTOCOL_CONFIG.permissionPrefix),
		).toBe(false);
	});

	test("server env vars are the MIMOCODE_* family", () => {
		expect(MIMO_SERVER_CONFIG.passwordEnvVar).toBe("MIMOCODE_SERVER_PASSWORD");
		expect(MIMO_SERVER_CONFIG.dbEnvVar).toBe("MIMOCODE_DB");
		expect(MIMO_SERVER_CONFIG.authUsername).toBe("mimocode");
	});

	test("platform package mapping hits the @mimo-ai scope", () => {
		expect(MIMO_SERVER_CONFIG.platformPkg("darwin-arm64")).toBe(
			"@mimo-ai/mimocode-darwin-arm64",
		);
	});

	test("parseProvider accepts mimo", () => {
		expect(parseProvider("mimo")).toBe("mimo");
	});
});

describe("resolveBinPath", () => {
	const ENV_VAR = MIMO_SERVER_CONFIG.binEnvVar;
	const saved = process.env[ENV_VAR];

	afterEach(() => {
		if (saved === undefined) delete process.env[ENV_VAR];
		else process.env[ENV_VAR] = saved;
	});

	test("HELMOR_MIMO_BIN_PATH override wins", () => {
		process.env[ENV_VAR] = "/tmp/custom/mimo";
		expect(resolveBinPath(MIMO_SERVER_CONFIG)).toBe("/tmp/custom/mimo");
	});

	test("falls back to platform sub-package or PATH name", () => {
		delete process.env[ENV_VAR];
		const resolved = resolveBinPath(MIMO_SERVER_CONFIG);
		// Dev/test machines with @mimo-ai/cli installed resolve the platform
		// binary; bare environments fall back to `mimo` on PATH. Both end
		// in the binary name.
		expect(
			resolved === "mimo" || /[\\/]bin[\\/]mimo(\.exe)?$/.test(resolved),
		).toBe(true);
	});
});
