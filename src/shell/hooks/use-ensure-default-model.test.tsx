import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createHelmorQueryClient, helmorQueryKeys } from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS, SettingsContext } from "@/lib/settings";
import { useEnsureDefaultModel } from "./use-ensure-default-model";

function renderUseEnsureDefaultModel(args: {
	defaultModelId: string | null;
	sections: Array<{
		id: "claude" | "codex";
		label: string;
		status?: "ready" | "unavailable" | "error";
		options: Array<{
			id: string;
			provider: "claude" | "codex";
			label: string;
			cliModel: string;
		}>;
	}>;
	settingsOverrides?: Partial<AppSettings>;
}) {
	const queryClient = createHelmorQueryClient();
	queryClient.setQueryData(helmorQueryKeys.agentModelSections, args.sections);
	const updateSettings = vi.fn();

	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<SettingsContext.Provider
				value={{
					settings: {
						...DEFAULT_SETTINGS,
						defaultModel: args.defaultModelId
							? { provider: null, modelId: args.defaultModelId }
							: null,
						...args.settingsOverrides,
					},
					isLoaded: true,
					updateSettings,
				}}
			>
				{children}
			</SettingsContext.Provider>
		</QueryClientProvider>
	);

	renderHook(() => useEnsureDefaultModel(), { wrapper });
	return { updateSettings };
}

describe("useEnsureDefaultModel", () => {
	it("repairs an invalid saved model once the catalog is settled", () => {
		const { updateSettings } = renderUseEnsureDefaultModel({
			defaultModelId: "gpt-legacy",
			sections: [
				{
					id: "claude",
					label: "Claude Code",
					status: "ready",
					options: [
						{
							id: "opus-1m",
							provider: "claude",
							label: "Opus",
							cliModel: "opus-1m",
						},
					],
				},
				{
					id: "codex",
					label: "Codex",
					status: "unavailable",
					options: [],
				},
			],
		});

		// Materializes review/pr fields alongside the default so a fresh
		// install doesn't depend on the next cold-start migration.
		const opus = { provider: "claude", modelId: "opus-1m" };
		expect(updateSettings).toHaveBeenCalledWith({
			defaultModel: opus,
			reviewModel: opus,
			prModel: opus,
			reviewEffort: DEFAULT_SETTINGS.defaultEffort,
			prEffort: DEFAULT_SETTINGS.defaultEffort,
			reviewFastMode: DEFAULT_SETTINGS.defaultFastMode,
			prFastMode: DEFAULT_SETTINGS.defaultFastMode,
		});
	});

	it("preserves existing non-null review/pr overrides when materializing", () => {
		const { updateSettings } = renderUseEnsureDefaultModel({
			defaultModelId: "gpt-legacy",
			sections: [
				{
					id: "claude",
					label: "Claude Code",
					status: "ready",
					options: [
						{
							id: "opus-1m",
							provider: "claude",
							label: "Opus",
							cliModel: "opus-1m",
						},
					],
				},
				{ id: "codex", label: "Codex", status: "unavailable", options: [] },
			],
			settingsOverrides: {
				reviewModel: { provider: "claude", modelId: "opus-1m" },
				reviewEffort: "low",
				prFastMode: true,
			},
		});

		expect(updateSettings).toHaveBeenCalledWith({
			defaultModel: { provider: "claude", modelId: "opus-1m" },
			// reviewModel / reviewEffort / prFastMode preserved (already set).
			prModel: { provider: "claude", modelId: "opus-1m" },
			prEffort: DEFAULT_SETTINGS.defaultEffort,
			reviewFastMode: DEFAULT_SETTINGS.defaultFastMode,
		});
	});

	it("unsets stale review/pr models that left the catalog", () => {
		const { updateSettings } = renderUseEnsureDefaultModel({
			defaultModelId: "opus-1m",
			sections: [
				{
					id: "claude",
					label: "Claude Code",
					status: "ready",
					options: [
						{
							id: "opus-1m",
							provider: "claude",
							label: "Opus",
							cliModel: "opus-1m",
						},
					],
				},
				{
					id: "codex",
					label: "Codex",
					status: "ready",
					options: [
						{
							id: "gpt-5.5",
							provider: "codex",
							label: "GPT-5.5",
							cliModel: "gpt-5.5",
						},
					],
				},
			],
			settingsOverrides: {
				reviewModel: { provider: null, modelId: "gpt-5.2" },
				prModel: { provider: null, modelId: "gpt-5.3-codex" },
			},
		});

		// Default is valid, so only the delisted review/pr picks are reset to
		// null (→ fall back to the default at consumption time).
		expect(updateSettings).toHaveBeenCalledWith({
			reviewModel: null,
			prModel: null,
		});
	});

	it("pins the repaired default to the Opus 4.8 1M entry, not the first option", () => {
		// Fable 5 leads the picker but is too expensive to be the app
		// default — the repair must skip it and land on Opus 4.8 1M.
		const { updateSettings } = renderUseEnsureDefaultModel({
			defaultModelId: null,
			sections: [
				{
					id: "claude",
					label: "Claude Code",
					status: "ready",
					options: [
						{
							id: "claude-fable-5[1m]",
							provider: "claude",
							label: "Fable 5 1M",
							cliModel: "claude-fable-5[1m]",
						},
						{
							id: "claude-opus-4-8[1m]",
							provider: "claude",
							label: "Opus 4.8 1M",
							cliModel: "claude-opus-4-8[1m]",
						},
					],
				},
				{ id: "codex", label: "Codex", status: "unavailable", options: [] },
			],
		});

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultModel: { provider: "claude", modelId: "claude-opus-4-8[1m]" },
			}),
		);
	});

	it("preserves an invalid saved model while any provider is still in error", () => {
		const { updateSettings } = renderUseEnsureDefaultModel({
			defaultModelId: "gpt-legacy",
			sections: [
				{
					id: "claude",
					label: "Claude Code",
					status: "ready",
					options: [
						{
							id: "opus-1m",
							provider: "claude",
							label: "Opus",
							cliModel: "opus-1m",
						},
					],
				},
				{
					id: "codex",
					label: "Codex",
					status: "error",
					options: [],
				},
			],
		});

		expect(updateSettings).not.toHaveBeenCalled();
	});
});
