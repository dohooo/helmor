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

	// Streamdown's default `rehype-sanitize` schema only allows `http` /
	// `https` for `<img src>`, which strips our `helmor-attachment://`
	// URLs. With the src gone, `rehype-harden` then replaces the image
	// with a `[Image blocked: ...]` span. Extend the schema to opt our
	// own custom Tauri protocols in (helmor-attachment for triage
	// previews, slack-file for inbox previews) — the rest of the
	// default plugin chain stays untouched.
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
