import { HelmorLogoAnimated } from "./helmor-logo-animated";

export function SplashScreen({ visible }: { visible: boolean }) {
	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center bg-background transition-opacity duration-400"
			style={{ opacity: visible ? 1 : 0 }}
		>
			<HelmorLogoAnimated size={64} className="opacity-80" />
		</div>
	);
}
