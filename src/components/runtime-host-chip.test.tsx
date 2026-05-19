// Phase 22d unit tests for the host chip. Keeps the local-vs-remote
// branching honest — every call site (sidebar / header / toast)
// relies on the same `isRemoteRuntime` predicate to decide whether
// to render the chip at all.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isRemoteRuntime, RuntimeHostChip } from "./runtime-host-chip";

afterEach(() => cleanup());

describe("isRemoteRuntime", () => {
	it("treats null/undefined/empty/local as 'not a remote'", () => {
		// The resolver and the column store both treat these
		// interchangeably; the chip needs to follow the same rule
		// so a workspace bound to `"local"` (or NULL) renders no chip.
		expect(isRemoteRuntime(null)).toBe(false);
		expect(isRemoteRuntime(undefined)).toBe(false);
		expect(isRemoteRuntime("")).toBe(false);
		expect(isRemoteRuntime("   ")).toBe(false);
		expect(isRemoteRuntime("local")).toBe(false);
	});

	it("treats any other non-empty value as a remote", () => {
		expect(isRemoteRuntime("dev.box")).toBe(true);
		expect(isRemoteRuntime("ec2-staging")).toBe(true);
		// Mixed-case names are remote — only the literal `"local"` is
		// the local sentinel.
		expect(isRemoteRuntime("Local")).toBe(true);
	});
});

describe("RuntimeHostChip", () => {
	it("renders nothing for the local runtime", () => {
		const { container } = render(<RuntimeHostChip runtimeName={null} />);
		expect(container.firstChild).toBeNull();
		cleanup();
		const { container: localContainer } = render(
			<RuntimeHostChip runtimeName="local" />,
		);
		expect(localContainer.firstChild).toBeNull();
	});

	it("renders the runtime name + an aria-labelled chip for remotes", () => {
		render(<RuntimeHostChip runtimeName="dev.box" />);
		// The accessible label is what screen readers + tests anchor
		// on; the visible text is just the runtime name.
		const chip = screen.getByLabelText("Workspace runtime: dev.box");
		expect(chip).toBeInTheDocument();
		expect(chip).toHaveTextContent("dev.box");
	});

	it("surfaces a tooltip via the title attribute", () => {
		render(<RuntimeHostChip runtimeName="dev.box" />);
		const chip = screen.getByLabelText("Workspace runtime: dev.box");
		expect(chip).toHaveAttribute("title", "Workspace runs on dev.box");
	});

	it("supports the compact variant for confirm-modal density", () => {
		render(<RuntimeHostChip runtimeName="dev.box" variant="compact" />);
		const chip = screen.getByLabelText("Workspace runtime: dev.box");
		// The variant changes sizing classes — both flavours should
		// surface the chip, so we just confirm it renders.
		expect(chip).toBeInTheDocument();
	});
});
