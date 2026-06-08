// src/shell/panes/identity-context.test.tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneIdentityContext, usePaneIdentity } from "./identity-context";
import type { PaneIdentity } from "./types";

describe("usePaneIdentity", () => {
	it("returns the value provided by the context", () => {
		const value: PaneIdentity = {
			paneId: "p1",
			workspaceId: "ws-a",
			sessionId: "s-x",
		};
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<PaneIdentityContext.Provider value={value}>
				{children}
			</PaneIdentityContext.Provider>
		);
		const { result } = renderHook(() => usePaneIdentity(), { wrapper });
		expect(result.current).toEqual(value);
	});

	it("throws when used outside a provider", () => {
		expect(() => renderHook(() => usePaneIdentity())).toThrowError(
			/usePaneIdentity must be used inside <PaneShell>/,
		);
	});
});
