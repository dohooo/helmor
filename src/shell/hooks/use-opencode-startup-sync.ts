import { useEffect, useRef } from "react";
import { useOpencodeModelSync } from "@/features/settings/panels/providers/use-opencode-model-sync";
import { useSettings } from "@/lib/settings";

/** On app start, restart `opencode serve` once to re-read ~/.config/opencode,
 *  so config edits made while Helmor was closed land in the composer's model
 *  list without opening Settings. Gated on prior opencode use so a cold start
 *  that never touches opencode doesn't pay for spawning the server. */
export function useOpencodeStartupSync() {
	const { settings, isLoaded } = useSettings();
	const { sync } = useOpencodeModelSync();
	const ranRef = useRef(false);

	const usedOpencode = settings.opencodeProvider.cachedModels !== null;
	useEffect(() => {
		if (!isLoaded || ranRef.current || !usedOpencode) return;
		ranRef.current = true;
		void sync({ forceReload: true });
	}, [isLoaded, usedOpencode, sync]);
}
