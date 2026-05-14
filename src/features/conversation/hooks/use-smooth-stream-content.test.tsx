import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSmoothStreamContent } from "./use-smooth-stream-content";

describe("useSmoothStreamContent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("flushes the visible text when streaming turns off after the target already advanced", () => {
		vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

		const fullText =
			"明白。后续我会直接在本地原始仓库修改：\n\n`/Users/aidan/mi/mihome/miot-plugin-sdk/projects/com.xiaomi.robovac`\n\n不再先改 Helmor worktree 再复制。";

		const { result, rerender } = renderHook(
			({ content, enabled }: { content: string; enabled: boolean }) =>
				useSmoothStreamContent(content, { enabled }),
			{ initialProps: { content: "", enabled: true } },
		);

		act(() => {
			rerender({ content: fullText, enabled: true });
		});

		expect(result.current).not.toBe(fullText);

		act(() => {
			rerender({ content: fullText, enabled: false });
		});

		expect(result.current).toBe(fullText);
	});
});
