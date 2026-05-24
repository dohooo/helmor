// Reverse IPC: call Helmor's Rust host from the sidecar.
//
// Symmetric to `SidecarRequest` but inverted — sidecar emits `hostRequest`
// on stdout, Rust dispatches by `method`, writes `hostResponse` back to
// sidecar stdin. The main stdin loop forwards `hostResponse` events here
// via `resolveHostResponse`.

import { randomUUID } from "node:crypto";

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let writer: ((event: object) => void) | null = null;

const DEFAULT_TIMEOUT_MS = 60_000;

export function setHostWriter(fn: (event: object) => void): void {
	writer = fn;
}

export function callHost<T>(
	method: string,
	params: unknown = null,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
	const w = writer;
	if (!w) {
		return Promise.reject(
			new Error(
				"host-bridge: writer not initialized (setHostWriter not called)",
			),
		);
	}
	const callbackId = randomUUID();
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(callbackId);
			reject(new Error(`hostRequest ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		pending.set(callbackId, {
			resolve: (v) => resolve(v as T),
			reject,
			timer,
		});
		w({ type: "hostRequest", callbackId, method, params });
	});
}

export function resolveHostResponse(payload: {
	callbackId?: unknown;
	ok?: unknown;
	error?: unknown;
}): void {
	if (typeof payload.callbackId !== "string") return;
	const p = pending.get(payload.callbackId);
	if (!p) return;
	pending.delete(payload.callbackId);
	clearTimeout(p.timer);
	if (typeof payload.error === "string") {
		p.reject(new Error(payload.error));
	} else {
		p.resolve(payload.ok ?? null);
	}
}
