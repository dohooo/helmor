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

/** Lark / Feishu glyph (IconPark "new-lark"). Uses `currentColor`. */
export function LarkBrandIcon({
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
			viewBox="0 0 48 48"
			width={size}
			height={size}
			fill="none"
			className={cn("block shrink-0 overflow-visible", className)}
			{...accessibilityProps}
		>
			<g fill="none">
				<path
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={4}
					d="M17 29C21 29 25 26.9339 28 23.4065C36 14 41.4242 16.8166 44 17.9998C38.5 20.9998 40.5 29.6233 33 35.9998C28.382 39.9259 23.4945 41.014 19 41C12.5231 40.9799 6.86226 37.7637 4 35.4063V16.9998"
				/>
				<path
					fill="currentColor"
					d="M5.64808 15.8669C5.02231 14.9567 3.77715 14.7261 2.86694 15.3519C1.95673 15.9777 1.72615 17.2228 2.35192 18.1331L5.64808 15.8669ZM36.0021 35.7309C36.958 35.1774 37.2843 33.9539 36.7309 32.9979C36.1774 32.042 34.9539 31.7157 33.9979 32.2691L36.0021 35.7309ZM2.35192 18.1331C5.2435 22.339 10.7992 28.144 16.8865 32.2239C19.9345 34.2667 23.217 35.946 26.449 36.7324C29.6946 37.522 33.0451 37.4428 36.0021 35.7309L33.9979 32.2691C32.2049 33.3072 29.9929 33.478 27.3947 32.8458C24.783 32.2103 21.9405 30.7958 19.1135 28.9011C13.4508 25.106 8.2565 19.661 5.64808 15.8669L2.35192 18.1331Z"
				/>
				<path
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={4}
					d="M33.5947 17C32.84 14.7027 30.8551 9.94054 27.5947 7H11.5947C15.2174 10.6757 23.0002 16 27.0002 24"
				/>
			</g>
		</svg>
	);
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
