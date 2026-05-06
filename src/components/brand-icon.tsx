import { type SimpleIcon, siGithub, siGitlab, siLinear } from "simple-icons";
import { cn } from "@/lib/utils";

type BrandIconProps = {
	icon: SimpleIcon;
	size?: number;
	className?: string;
	/**
	 * Accessible name. Omit for decorative icons (default) — the SVG is
	 * then marked `aria-hidden` so it doesn't contaminate the parent
	 * element's accessible name (e.g. a button with adjacent text).
	 * Pass a string when the icon stands alone and needs a label.
	 */
	"aria-label"?: string;
};

/**
 * Thin SVG wrapper around a Simple Icons entry. Renders the brand's
 * official glyph using `currentColor` so callers can tint via Tailwind
 * `text-*` utilities — don't hard-code the brand `hex` unless the design
 * explicitly asks for the full-color wordmark.
 */
export function BrandIcon({
	icon,
	size = 16,
	className,
	"aria-label": ariaLabel,
}: BrandIconProps) {
	const accessibilityProps =
		ariaLabel !== undefined
			? ({ role: "img", "aria-label": ariaLabel } as const)
			: ({ "aria-hidden": true } as const);
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="currentColor"
			className={cn("block shrink-0 overflow-visible", className)}
			{...accessibilityProps}
		>
			<path d={icon.path} />
		</svg>
	);
}

/** GitHub brand glyph (Simple Icons). Uses `currentColor`. */
export function GithubBrandIcon(props: Omit<BrandIconProps, "icon">) {
	return <BrandIcon icon={siGithub} {...props} />;
}

/** GitLab brand glyph (Simple Icons). Uses `currentColor`. */
export function GitlabBrandIcon(props: Omit<BrandIconProps, "icon">) {
	return <BrandIcon icon={siGitlab} {...props} />;
}

/** Linear brand glyph (Simple Icons). Uses `currentColor`. */
export function LinearBrandIcon(props: Omit<BrandIconProps, "icon">) {
	return <BrandIcon icon={siLinear} {...props} />;
}

/** Slack brand glyph. Uses `currentColor`. */
export function SlackBrandIcon({
	size = 16,
	className,
	"aria-label": ariaLabel,
}: Omit<BrandIconProps, "icon">) {
	const accessibilityProps =
		ariaLabel !== undefined
			? ({ role: "img", "aria-label": ariaLabel } as const)
			: ({ "aria-hidden": true } as const);
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 127 127"
			width={size}
			height={size}
			fill="currentColor"
			className={cn("block shrink-0 overflow-visible", className)}
			{...accessibilityProps}
		>
			<path d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z" />
			<path d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z" />
			<path d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z" />
			<path d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z" />
		</svg>
	);
}
