import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/** Wraps a provider's expanded config so that, when not signed in, everything
 *  is disabled (inert + dimmed) and a one-line hint explains why. For providers
 *  unusable without login — e.g. Kimi, whose ACP gate rejects every session
 *  until you sign in, even when only a custom provider is configured. */
export function LoginGate({
	locked,
	message,
	children,
}: {
	locked: boolean;
	message: string;
	children: ReactNode;
}) {
	const { t } = useI18n();
	if (!locked) return <>{children}</>;
	return (
		<>
			<div className="pb-3 pl-8 pr-6 text-small leading-snug text-muted-foreground">
				{t(message)}
			</div>
			{/* inert (React 19): no pointer/keyboard interaction, out of tab order. */}
			<div inert className="select-none opacity-50">
				{children}
			</div>
		</>
	);
}
