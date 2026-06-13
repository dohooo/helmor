// Adapter for the two opencode-protocol providers (OpenCode and its MiMo Code
// fork). All shapes are identical — only ids/labels/IPC fns/settings keys/query
// keys differ, so the models + custom-providers settings UI is parameterized
// over this object instead of duplicated.

import {
	deleteMimoCustomProvider,
	deleteOpencodeCustomProvider,
	getMimoCustomProviders,
	getOpencodeCustomProviders,
	listMimoModels,
	listOpencodeModels,
	upsertMimoCustomProvider,
	upsertOpencodeCustomProvider,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	findMimoPreset,
	MIMO_PROVIDER_PRESETS,
} from "./builtin-mimo-providers";
import {
	findOpencodePreset,
	OPENCODE_PROVIDER_PRESETS,
	type OpencodeProviderPreset,
} from "./builtin-opencode-providers";
import {
	isMimoBuiltinProvider,
	isOpencodeBuiltinProvider,
} from "./opencode-model-defaults";

export type SlugProviderAdapter = {
	provider: "opencode" | "mimo";
	displayName: string;
	settingsKey: "opencodeProvider" | "mimoProvider";
	/** Shown in the sync tooltip + custom-providers description. */
	configPathLabel: string;
	listModels: typeof listOpencodeModels;
	getCustomProviders: typeof getOpencodeCustomProviders;
	upsertCustomProvider: typeof upsertOpencodeCustomProvider;
	deleteCustomProvider: typeof deleteOpencodeCustomProvider;
	customProvidersQueryKey: readonly string[];
	/** Keyed so `useIsMutating` can surface a "Connecting…" state while any
	 *  sync (settings button or app-start) runs. */
	modelSyncMutationKey: readonly string[];
	presets: readonly OpencodeProviderPreset[];
	findPreset: (key: string) => OpencodeProviderPreset | undefined;
	/** Built-in provider ids whose models are "intentional" (enabled by
	 *  default) even when the user never configured them. */
	isBuiltinIntentional: (providerId: string) => boolean;
};

export const OPENCODE_ADAPTER: SlugProviderAdapter = {
	provider: "opencode",
	displayName: "OpenCode",
	settingsKey: "opencodeProvider",
	configPathLabel: "~/.config/opencode",
	listModels: listOpencodeModels,
	getCustomProviders: getOpencodeCustomProviders,
	upsertCustomProvider: upsertOpencodeCustomProvider,
	deleteCustomProvider: deleteOpencodeCustomProvider,
	customProvidersQueryKey: helmorQueryKeys.opencodeCustomProviders,
	modelSyncMutationKey: ["opencodeModelSync"],
	presets: OPENCODE_PROVIDER_PRESETS,
	findPreset: findOpencodePreset,
	isBuiltinIntentional: isOpencodeBuiltinProvider,
};

export const MIMO_ADAPTER: SlugProviderAdapter = {
	provider: "mimo",
	displayName: "MiMo Code",
	settingsKey: "mimoProvider",
	configPathLabel: "~/.config/mimocode",
	listModels: listMimoModels,
	getCustomProviders: getMimoCustomProviders,
	upsertCustomProvider: upsertMimoCustomProvider,
	deleteCustomProvider: deleteMimoCustomProvider,
	customProvidersQueryKey: helmorQueryKeys.mimoCustomProviders,
	modelSyncMutationKey: ["mimoModelSync"],
	presets: MIMO_PROVIDER_PRESETS,
	findPreset: findMimoPreset,
	isBuiltinIntentional: isMimoBuiltinProvider,
};
