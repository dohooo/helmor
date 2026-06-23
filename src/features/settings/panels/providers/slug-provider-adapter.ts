// Adapter for the opencode-protocol provider (OpenCode): drives the
// server-sync Models row and model sync.

import {
	type CustomProvider,
	listCustomProviders,
	listOpencodeModels,
} from "@/lib/api";
import { isOpencodeBuiltinProvider } from "./opencode-model-defaults";

export type SlugProviderAdapter = {
	provider: "opencode";
	displayName: string;
	settingsKey: "opencodeProvider";
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
