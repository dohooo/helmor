import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAcpConnection } from "./acp-connection.js";

/**
 * Scriptable fake ACP agent. Speaks just enough newline-delimited JSON-RPC
 * for the connection tests: `initialize` answers immediately (protocol
 * version via FAKE_ACP_PROTOCOL_VERSION), `slow/echo` answers after 150ms,
 * `never` never answers, `die` prints to stderr and exits non-zero.
 * It also prints a non-JSON banner line — the parser must tolerate noise.
 */
const FAKE_AGENT = `#!/usr/bin/env bun
const protocolVersion = Number(process.env.FAKE_ACP_PROTOCOL_VERSION ?? "1");
console.log("fake-acp banner — not JSON");
function respond(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let idx = buf.indexOf("\\n");
	while (idx >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		idx = buf.indexOf("\\n");
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.method === "initialize") {
			respond(msg.id, { protocolVersion, agentCapabilities: {} });
		} else if (msg.method === "slow/echo") {
			setTimeout(() => respond(msg.id, { ok: true }), 150);
		} else if (msg.method === "die") {
			process.stderr.write("boom: fake fatal error\\n");
			setTimeout(() => process.exit(1), 20);
		} // "never": no response on purpose
	}
});
`;

// Make the fake agent spawnable. POSIX honors the shebang on a 0755 script;
// Windows can't exec a shebang/extensionless file, and spawn() rejects
// .cmd/.bat without a shell — so compile a real .exe. Done at module load so
// the (multi-second) compile isn't bound by the per-test timeout.
function buildFakeKimiBin(): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-acp-"));
	if (process.platform === "win32") {
		const scriptPath = join(dir, "fake-kimi.ts");
		writeFileSync(scriptPath, FAKE_AGENT);
		const binPath = join(dir, "fake-kimi.exe");
		execFileSync(
			process.execPath,
			["build", scriptPath, "--compile", "--outfile", binPath],
			{ stdio: "ignore" },
		);
		return binPath;
	}
	const binPath = join(dir, "fake-kimi");
	writeFileSync(binPath, FAKE_AGENT, { mode: 0o755 });
	return binPath;
}

const fakeKimiBin = buildFakeKimiBin();
const previousBinPath = process.env.HELMOR_KIMI_BIN_PATH;
const connections: KimiAcpConnection[] = [];

beforeAll(() => {
	process.env.HELMOR_KIMI_BIN_PATH = fakeKimiBin;
});

afterAll(() => {
	if (previousBinPath === undefined) delete process.env.HELMOR_KIMI_BIN_PATH;
	else process.env.HELMOR_KIMI_BIN_PATH = previousBinPath;
});

afterEach(() => {
	for (const connection of connections.splice(0)) connection.kill();
	delete process.env.FAKE_ACP_PROTOCOL_VERSION;
});

function connect(onExit: () => void = () => {}): KimiAcpConnection {
	const connection = new KimiAcpConnection({
		onNotification: () => {},
		onRequest: () => {},
		onExit,
	});
	connections.push(connection);
	return connection;
}

describe("KimiAcpConnection", () => {
	test("handshake succeeds despite non-JSON banner noise", async () => {
		const connection = connect();
		const init = await connection.start();
		expect(init.protocolVersion).toBe(1);
		expect(connection.isLive).toBe(true);
	});

	test("timeoutMs = 0 means no deadline, not an instant timeout", async () => {
		// Regression guard: `session/prompt` is sent with timeoutMs=0 and the
		// response only arrives at turn end — an unconditional setTimeout(fn, 0)
		// would reject every prompt within milliseconds.
		const connection = connect();
		await connection.start();
		const result = await connection.sendRequest<{ ok: boolean }>(
			"slow/echo",
			{},
			0,
		);
		expect(result.ok).toBe(true);
	});

	test("a positive timeout still rejects an unanswered request", async () => {
		const connection = connect();
		await connection.start();
		await expect(connection.sendRequest("never", {}, 50)).rejects.toThrow(
			/Timed out waiting for never/,
		);
	});

	test("child death rejects in-flight requests with the stderr tail", async () => {
		const connection = connect();
		await connection.start();
		await expect(connection.sendRequest("die", {}, 0)).rejects.toThrow(
			/exited[\s\S]*boom: fake fatal error/,
		);
	});

	test("requests after exit fail fast instead of hanging", async () => {
		let exited: () => void = () => {};
		const exit = new Promise<void>((resolve) => {
			exited = resolve;
		});
		const connection = connect(() => exited());
		await connection.start();
		await expect(connection.sendRequest("die", {}, 0)).rejects.toThrow();
		await exit;
		// No live child: the pending entry would never be settled by anyone.
		await expect(connection.sendRequest("slow/echo", {}, 0)).rejects.toThrow(
			/not running/,
		);
	});

	test("start() rejects on an unsupported protocol version", async () => {
		process.env.FAKE_ACP_PROTOCOL_VERSION = "99";
		const connection = connect();
		await expect(connection.start()).rejects.toThrow(
			/unsupported protocol version 99/,
		);
	});
});
