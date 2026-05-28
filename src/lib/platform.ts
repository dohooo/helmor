export function isMac(): boolean {
	if (typeof navigator === "undefined") return true;
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const platform = nav.userAgentData?.platform || navigator.platform || "";
	return /mac/i.test(platform);
}
