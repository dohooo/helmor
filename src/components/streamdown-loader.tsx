import { lazy } from "react";

const LazyStreamdown = lazy(async () => {
	const [
		{ Streamdown, defaultRehypePlugins },
		{ streamdownComponents },
		{ default: rehypeSanitize, defaultSchema },
	] = await Promise.all([
		import("streamdown"),
		import("@/components/streamdown-components"),
		import("rehype-sanitize"),
	]);

	type Pluggable = NonNullable<
		React.ComponentProps<typeof Streamdown>["rehypePlugins"]
	>[number];

	// Default sanitize schema only allows http(s) for img src — opt in our Tauri schemes (helmor-attachment, slack-file, asset).
	const helmorSanitizeSchema = {
		...defaultSchema,
		protocols: {
			...defaultSchema.protocols,
			src: [
				...(defaultSchema.protocols?.src ?? []),
				"helmor-attachment",
				"slack-file",
				"asset",
			],
		},
	};
	const customRehypePlugins: Pluggable[] = [
		defaultRehypePlugins.raw as Pluggable,
		[rehypeSanitize, helmorSanitizeSchema] as Pluggable,
		defaultRehypePlugins.harden as Pluggable,
	];

	function StreamdownWithOverrides(
		props: React.ComponentProps<typeof Streamdown>,
	) {
		return (
			<Streamdown
				rehypePlugins={customRehypePlugins}
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
	void import("rehype-sanitize");
	void import("@/components/streamdown-components");
}

export { LazyStreamdown };
