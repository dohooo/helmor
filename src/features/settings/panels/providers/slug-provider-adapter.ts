// Adapter for the two opencode-protocol providers (OpenCode + MiMo Code fork):
// drives the server-sync Models row and model sync.

import {
	type CustomProvider,
	listCustomProviders,
	listMimoModels,
	listOpencodeModels,
} from "@/lib/api";
import {
	isMimoBuiltinProvider,
	isOpencodeBuiltinProvider,
} from "./opencode-model-defaults";

export type SlugProviderAdapter = {
	provider: "opencode" | "mimo";
	displayName: string;
	settingsKey: "opencodeProvider" | "mimoProvider";
	/** Shown in the sync tooltip. */
	configPathLabel: string;
	listModels: typeof listOpencodeModels;
	/** Configured custom providers — for reconciling default-enabled models. */
	getCustomProviders: () => Promise<CustomProvider[]>;
	/** Keyed so `useIsMutating` can surface a "Connecting…" state while any
	 *  sync (settings button or app-start) runs. */
	modelSyncMutationKey: readonly string[];
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
	getCustomProviders: () => listCustomProviders("opencode"),
	modelSyncMutationKey: ["opencodeModelSync"],
	isBuiltinIntentional: isOpencodeBuiltinProvider,
};

export const MIMO_ADAPTER: SlugProviderAdapter = {
	provider: "mimo",
	displayName: "MiMo Code",
	settingsKey: "mimoProvider",
	configPathLabel: "~/.config/mimocode",
	listModels: listMimoModels,
	getCustomProviders: () => listCustomProviders("mimo"),
	modelSyncMutationKey: ["mimoModelSync"],
	isBuiltinIntentional: isMimoBuiltinProvider,
};
