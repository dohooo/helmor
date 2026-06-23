// MiMo Code preset list: MiMo-specific featured presets first (Xiaomi MiMo
// platform), then everything opencode supports — the fork ships the same
// models.dev catalog, so the opencode presets all work against `mimo` too.

import catalog from "@/shared/provider-catalog.json";
import type { OpencodeProviderPreset } from "./builtin-opencode-providers";
import { OPENCODE_PROVIDER_PRESETS } from "./builtin-opencode-providers";

export const MIMO_PROVIDER_PRESETS: readonly OpencodeProviderPreset[] = [
	...(catalog.mimo as readonly OpencodeProviderPreset[]),
	...OPENCODE_PROVIDER_PRESETS,
];

export function findMimoPreset(key: string) {
	return MIMO_PROVIDER_PRESETS.find((preset) => preset.key === key);
}
