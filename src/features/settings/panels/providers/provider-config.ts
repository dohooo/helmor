// Unified provider-config adapter: one interface shared by all four agent
// families, so the Settings UI is identical. Domain types in `@/lib/provider-config`.

import type { ProviderBrandIconKey } from "@/components/icons";
import type {
	ApiStyle,
	CustomProvider,
	CustomProviderModel,
	ProviderFamily,
} from "@/lib/provider-config";

export type {
	ApiStyle,
	CustomProvider,
	CustomProviderModel,
	ProviderFamily,
} from "@/lib/provider-config";
export { resolveEnabled, toggleEnabled } from "@/lib/provider-config";

/** A built-in provider preset offered in the "Add provider" menu. */
export type ProviderPreset = {
	key: string;
	label: string;
	icon: ProviderBrandIconKey;
	/** Pinned base URL, or "" for API-key-only registry presets. */
	baseUrl: string;
	apiKeyUrl?: string;
	apiStyle?: ApiStyle;
	/** API key only — no base URL / models editor (models come from the server). */
	apiKeyOnly?: boolean;
};

// Section-level "Models" multi-select state (merged placement only).
export type SectionModelsController = {
	available: CustomProviderModel[];
	/** Resolved enabled ids (`null` "all" already expanded). */
	enabledIds: string[];
	enabledSet: Set<string>;
	toggle: (id: string) => void;
	clear: () => void;
	loading: boolean;
	/** Undefined → no refresh. */
	refresh?: () => void;
	/** Group by sub-provider (OpenCode) vs a flat list. */
	grouped: boolean;
};

export type CustomProvidersController = {
	providers: CustomProvider[];
	loading: boolean;
	upsert: (provider: CustomProvider) => Promise<void> | void;
	remove: (id: string) => Promise<void> | void;
};

export type ProviderCaps = {
	baseUrlEditable: boolean;
	/** Show the wire-protocol / API-style selector (OpenCode/MiMo/Kimi). */
	apiStyleSelectable: boolean;
};

/** One choice in the wire-protocol / API-style selector. `value` is stored
 *  verbatim in `CustomProvider.apiStyle` and interpreted by the family backend
 *  (OpenCode: chat|responses; Kimi: openai|anthropic|…). */
export type StyleOption = { value: string; label: string; hint?: string };

export type ProviderConfigAdapter = {
	family: ProviderFamily;
	displayName: string;
	presets: readonly ProviderPreset[];
	caps: ProviderCaps;
	customProvidersDescription: string;
	/** Options for the wire-protocol selector (shown when `caps.apiStyleSelectable`).
	 *  Omitted → OpenCode's default Chat/Responses pair. */
	styleOptions?: readonly StyleOption[];
	/** Selector heading — "API style" (default) vs e.g. "Provider type". */
	styleLabel?: string;
	useCustomProviders: () => CustomProvidersController;
	fetchModels: (provider: CustomProvider) => Promise<CustomProviderModel[]>;
	/** Omitted by families that render their own Models row (OpenCode/MiMo). */
	useSectionModels?: () => SectionModelsController;
};
