/**
 * Frontend mirror of the Rust `ErrorCode` enum (see `src-tauri/src/error.rs`).
 * Tauri command errors arrive as `{ code, message }` — use `extractError` to
 * normalize anything else into that shape.
 */

export type ErrorCode =
	| "Unknown"
	| "WorkspaceBroken"
	| "WorkspaceNotFound"
	| "ForgeOnboarding";

export type CodedError = {
	code: ErrorCode;
	message: string;
};

function isErrorCode(value: unknown): value is ErrorCode {
	return (
		value === "Unknown" ||
		value === "WorkspaceBroken" ||
		value === "WorkspaceNotFound" ||
		value === "ForgeOnboarding"
	);
}

/** Normalize anything thrown by `invoke()` or caught in a handler. */
export function extractError(error: unknown, fallback: string): CodedError {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		"message" in error &&
		typeof (error as { message: unknown }).message === "string" &&
		(error as { message: string }).message.trim() !== ""
	) {
		const { code, message } = error as { code: unknown; message: string };
		return { code: isErrorCode(code) ? code : "Unknown", message };
	}

	if (error instanceof Error && error.message.trim()) {
		return { code: "Unknown", message: error.message };
	}

	if (typeof error === "string" && error.trim()) {
		return { code: "Unknown", message: error };
	}

	if (typeof error === "object" && error !== null && "message" in error) {
		const { message } = error as { message: unknown };
		if (typeof message === "string" && message.trim()) {
			return { code: "Unknown", message };
		}
	}

	try {
		const serialized = JSON.stringify(error);
		if (serialized && serialized !== "{}") {
			return { code: "Unknown", message: serialized };
		}
	} catch {
		// fall through
	}

	return { code: "Unknown", message: fallback };
}

/** True when the error indicates the workspace is orphaned — user's only remedy is to purge it. */
export function isRecoverableByPurge(code: ErrorCode): boolean {
	return code === "WorkspaceBroken" || code === "WorkspaceNotFound";
}
