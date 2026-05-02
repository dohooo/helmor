import {
	type ComponentProps,
	memo,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useCachedAvatar } from "@/lib/use-cached-avatar";

type AvatarRootProps = ComponentProps<typeof Avatar>;

type CachedAvatarProps = Omit<AvatarRootProps, "children"> & {
	/** Remote avatar URL. Pass `null` / `""` to render only the fallback. */
	src: string | null | undefined;
	alt: string;
	/** What to show when src is missing or the image fails to load. */
	fallback: ReactNode;
	fallbackClassName?: string;
	/** Forwarded to the inner `<AvatarImage>`. */
	imageClassName?: string;
};

/** Avatar that resolves remote URLs through the on-disk cache so page
 * navigations don't re-trigger HTTP fetch + image decode. While the
 * cache is filling on the very first ever use the Avatar is empty —
 * never flashes initials, which is the whole point. Initials show only
 * when no `src` is provided or when the underlying `<img>` errors. */
export const CachedAvatar = memo(function CachedAvatar({
	src,
	alt,
	fallback,
	fallbackClassName,
	imageClassName,
	...rootProps
}: CachedAvatarProps) {
	const resolvedSrc = useCachedAvatar(src);
	const [hasImage, setHasImage] = useState(true);

	useEffect(() => {
		setHasImage(true);
	}, [resolvedSrc]);

	const hasSrc = (src?.trim().length ?? 0) > 0;
	const showFallback = !hasSrc || !hasImage;

	return (
		<Avatar {...rootProps}>
			{resolvedSrc ? (
				<AvatarImage
					src={resolvedSrc}
					alt={alt}
					className={imageClassName}
					onError={() => setHasImage(false)}
					onLoad={() => setHasImage(true)}
				/>
			) : null}
			{showFallback ? (
				<AvatarFallback delayMs={0} className={fallbackClassName}>
					{fallback}
				</AvatarFallback>
			) : null}
		</Avatar>
	);
});
