import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceAvatar } from "./avatar";

describe("WorkspaceAvatar", () => {
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
