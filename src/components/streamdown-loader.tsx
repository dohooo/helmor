import { lazy } from "react";

const LazyStreamdown = lazy(async () => {
	const [{ Streamdown }, { streamdownComponents }] = await Promise.all([
		import("streamdown"),
		import("@/components/streamdown-components"),
	]);

	function StreamdownWithOverrides(
		props: React.ComponentProps<typeof Streamdown>,
	) {
		return (
			<Streamdown
				{...props}
				components={{ ...streamdownComponents, ...props.components }}
			/>
		);
	}

	return { default: StreamdownWithOverrides };
});

let hasPreloadedStreamdown = false;

export function preloadStreamdown() {
	if (hasPreloadedStreamdown) {
		return;
	}
	hasPreloadedStreamdown = true;
	void import("streamdown");
	void import("@/components/streamdown-components");
}

export { LazyStreamdown };
