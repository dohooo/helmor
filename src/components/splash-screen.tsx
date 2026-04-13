import { resolveTheme, useSettings } from "@/lib/settings";
import { HelmorLogoAnimated } from "./helmor-logo-animated";

const SPLASH_BG = { dark: "#0E0E0E", light: "#FEFEFE" } as const;

export function SplashScreen() {
	const { settings } = useSettings();
	const bg = SPLASH_BG[resolveTheme(settings.theme)];

	return (
		<div
			className="flex h-screen w-screen items-center justify-center"
			style={{ backgroundColor: bg }}
		>
			<HelmorLogoAnimated size={64} className="opacity-80" />
		</div>
	);
}
