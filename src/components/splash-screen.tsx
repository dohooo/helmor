import { HelmorLogoAnimated } from "./helmor-logo-animated";

export function SplashScreen() {
	return (
		<div className="flex h-screen w-screen items-center justify-center bg-background">
			<HelmorLogoAnimated size={64} className="opacity-80" />
		</div>
	);
}
