import { useEffect, useRef } from "react";
import {
	OPENCODE_ADAPTER,
	type SlugProviderAdapter,
} from "@/features/settings/panels/providers/slug-provider-adapter";
import { useSlugProviderModelSync } from "@/features/settings/panels/providers/use-opencode-model-sync";
import { useSettings } from "@/lib/settings";
import { isQuickPanelWindow } from "@/lib/window-role";

/** On app start, restart the provider's server once to re-read its global
 *  config, so config edits made while Helmor was closed land in the composer's
 *  model list without opening Settings. Gated on prior use of the provider so
 *  a cold start that never touches it doesn't pay for spawning the server. */
function useStartupSync(adapter: SlugProviderAdapter) {
	const { settings, isLoaded } = useSettings();
	const { sync } = useSlugProviderModelSync(adapter);
	const ranRef = useRef(false);

	const used = settings[adapter.settingsKey].cachedModels !== null;
	useEffect(() => {
		// One restart per APP start — the main window owns it; the quick panel
		// mounting later must not bounce the server again.
		if (isQuickPanelWindow) return;
		if (!isLoaded || ranRef.current || !used) return;
		ranRef.current = true;
		void sync({ forceReload: true });
	}, [isLoaded, used, sync]);
}

/** Startup model sync for the opencode-protocol provider, gated on its
 *  cached catalog. */
export function useSlugProviderStartupSync() {
	useStartupSync(OPENCODE_ADAPTER);
}
