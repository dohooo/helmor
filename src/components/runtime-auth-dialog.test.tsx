import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	setRuntimeAgentAuth: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		setRuntimeAgentAuth: apiMocks.setRuntimeAgentAuth,
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { RuntimeAuthDialog } from "./runtime-auth-dialog";

function withClient(): {
	wrapper: ({ children }: { children: ReactNode }) => ReactNode;
} {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { wrapper };
}

describe("RuntimeAuthDialog", () => {
	beforeEach(() => {
		apiMocks.setRuntimeAgentAuth.mockReset();
		apiMocks.setRuntimeAgentAuth.mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("pushes the typed key into setRuntimeAgentAuth on save", async () => {
		const user = userEvent.setup();
		const { wrapper } = withClient();
		const onOpenChange = vi.fn();
		render(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={onOpenChange}
				runtimeName="dev.box"
			/>,
			{ wrapper },
		);
		await user.type(screen.getByTestId("runtime-auth-api-key"), "sk-abc-123");
		await user.click(screen.getByTestId("runtime-auth-save"));
		await waitFor(() =>
			expect(apiMocks.setRuntimeAgentAuth).toHaveBeenCalledWith(
				"dev.box",
				"cursor",
				"sk-abc-123",
				null,
			),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("clears the key by sending null when the input is left blank", async () => {
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="staging"
			/>,
			{ wrapper },
		);
		// Save without typing anything — empty input means "clear stored key".
		await user.click(screen.getByTestId("runtime-auth-save"));
		await waitFor(() =>
			expect(apiMocks.setRuntimeAgentAuth).toHaveBeenCalledWith(
				"staging",
				"cursor",
				null,
				null,
			),
		);
	});

	it("forwards a non-empty base URL alongside the key", async () => {
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
			/>,
			{ wrapper },
		);
		await user.type(screen.getByTestId("runtime-auth-api-key"), "sk-aaa");
		await user.type(
			screen.getByTestId("runtime-auth-base-url"),
			"https://proxy.internal/v1",
		);
		await user.click(screen.getByTestId("runtime-auth-save"));
		await waitFor(() =>
			expect(apiMocks.setRuntimeAgentAuth).toHaveBeenCalledWith(
				"dev.box",
				"cursor",
				"sk-aaa",
				"https://proxy.internal/v1",
			),
		);
	});

	it("disables Save when no runtime is selected", async () => {
		const { wrapper } = withClient();
		render(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName={null}
			/>,
			{ wrapper },
		);
		expect(screen.getByTestId("runtime-auth-save")).toBeDisabled();
	});

	it("resets the typed values when reopened", async () => {
		const user = userEvent.setup();
		const { wrapper } = withClient();
		const { rerender } = render(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="dev.box"
			/>,
			{ wrapper },
		);
		await user.type(screen.getByTestId("runtime-auth-api-key"), "leftover");
		// Close + reopen for a different runtime.
		rerender(
			<RuntimeAuthDialog
				open={false}
				onOpenChange={() => {}}
				runtimeName="dev.box"
			/>,
		);
		rerender(
			<RuntimeAuthDialog
				open={true}
				onOpenChange={() => {}}
				runtimeName="staging"
			/>,
		);
		const input = await screen.findByTestId("runtime-auth-api-key");
		expect((input as HTMLInputElement).value).toBe("");
	});
});
