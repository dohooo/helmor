import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAvatar } from "./avatar";

describe("WorkspaceAvatar", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to initials when the icon src fails to load", async () => {
		// Radix's <Avatar.Image> never mounts the underlying <img> on error — it
		// renders null — so a native `onError` never fires. jsdom also never
		// loads images, leaving Radix's internal probe stuck in "loading"
		// forever. Stub window.Image so setting a src dispatches an error, which
		// drives our `onLoadingStatusChange` path. Without the fix this repo
		// (a non-empty but undecodable `data:image/x-icon;base64,` URI) would
		// render a permanently blank avatar.
		class FailingImage {
			#src = "";
			complete = false;
			naturalWidth = 0;
			#onError: (() => void) | null = null;
			addEventListener(type: string, cb: () => void) {
				if (type === "error") this.#onError = cb;
			}
			removeEventListener() {}
			set src(value: string) {
				this.#src = value;
				queueMicrotask(() => this.#onError?.());
			}
			get src() {
				return this.#src;
			}
		}
		vi.stubGlobal("Image", FailingImage);

		const { container } = render(
			<WorkspaceAvatar
				repoIconSrc="data:image/x-icon;base64,"
				repoInitials="RA"
				repoName="retail-api"
				title="retail-api"
			/>,
		);

		await waitFor(() => {
			const fallback = container.querySelector('[data-slot="avatar-fallback"]');
			expect(fallback).toBeInTheDocument();
			expect(fallback).toHaveTextContent("RA");
		});
	});

	it("renders fallback immediately when switching from an icon repo to a repo without an icon", () => {
		const { container, rerender } = render(
			<WorkspaceAvatar
				repoIconSrc="asset://repo-icon.png"
				repoInitials="RI"
				repoName="repo-icon"
				title="repo-icon"
			/>,
		);

		expect(
			container.querySelector('[data-slot="avatar-fallback"]'),
		).not.toBeInTheDocument();

		rerender(
			<WorkspaceAvatar
				repoIconSrc={null}
				repoInitials={null}
				repoName="ts-to-zod"
				title="ts-to-zod"
			/>,
		);

		const fallback = container.querySelector('[data-slot="avatar-fallback"]');
		expect(fallback).toBeInTheDocument();
		expect(fallback).toHaveTextContent("TT");
	});

	it("keeps fallback initials circular even when the avatar container is rounded-md", () => {
		const { container } = render(
			<WorkspaceAvatar
				repoIconSrc={null}
				repoInitials="TT"
				repoName="ts-to-zod"
				title="ts-to-zod"
				className="size-4 rounded-md"
			/>,
		);

		expect(
			container.querySelector('[data-slot="workspace-avatar"]'),
		).toHaveClass("rounded-full");
		expect(
			container.querySelector('[data-slot="avatar-fallback"]'),
		).toHaveClass("rounded-full");
	});
});
