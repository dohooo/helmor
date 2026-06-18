import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheForgeAvatar } from "./api";
import { convertLocalFileSrc } from "./ipc";
import { useCachedAvatar } from "./use-cached-avatar";

vi.mock("./api", () => ({
	cacheForgeAvatar: vi.fn(),
}));

vi.mock("./ipc", () => ({
	convertLocalFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

function makeClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				gcTime: Number.POSITIVE_INFINITY,
				retry: false,
			},
		},
	});
}

function wrapperFor(client: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
	};
}

describe("useCachedAvatar", () => {
	beforeEach(() => {
		vi.mocked(cacheForgeAvatar).mockReset();
		vi.mocked(convertLocalFileSrc).mockClear();
	});

	it("returns the remote URL immediately while the disk cache resolves", async () => {
		let resolveCache!: (path: string) => void;
		vi.mocked(cacheForgeAvatar).mockReturnValue(
			new Promise((resolve) => {
				resolveCache = resolve;
			}),
		);

		const { result } = renderHook(
			() => useCachedAvatar("https://avatars.example/u/1.png"),
			{ wrapper: wrapperFor(makeClient()) },
		);

		expect(result.current).toBe("https://avatars.example/u/1.png");
		expect(cacheForgeAvatar).toHaveBeenCalledWith(
			"https://avatars.example/u/1.png",
		);

		resolveCache("/cached/avatar.png");

		await waitFor(() => {
			expect(result.current).toBe("asset:///cached/avatar.png");
		});
		expect(convertLocalFileSrc).toHaveBeenCalledWith("/cached/avatar.png");
	});

	it("does not cache local or empty URLs", () => {
		const client = makeClient();
		const initialProps: { url: string | null | undefined } = {
			url: "asset://cached/avatar.png",
		};
		const { result, rerender } = renderHook(
			({ url }: { url: string | null | undefined }) => useCachedAvatar(url),
			{
				initialProps,
				wrapper: wrapperFor(client),
			},
		);

		expect(result.current).toBe("asset://cached/avatar.png");

		rerender({ url: "" });
		expect(result.current).toBeNull();

		rerender({ url: undefined });
		expect(result.current).toBeNull();
		expect(cacheForgeAvatar).not.toHaveBeenCalled();
	});
});
