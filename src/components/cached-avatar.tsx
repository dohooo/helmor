import {
	type ComponentProps,
	memo,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useCachedAvatar } from "@/lib/use-cached-avatar";
import { cn } from "@/lib/utils";

type AvatarRootProps = ComponentProps<typeof Avatar>;

type CachedAvatarProps = Omit<AvatarRootProps, "children"> & {
	/** Remote avatar URL. Pass `null` / `""` to render only the fallback. */
	src: string | null | undefined;
	alt: string;
	/** Bottom layer — initials, etc. Always present underneath the image. */
	fallback: ReactNode;
	fallbackClassName?: string;
	/** Forwarded to the overlay `<img>`. */
	imageClassName?: string;
};

/** Avatar with on-disk URL caching + a persistent initials underlay.
 *
 * Layered: `AvatarFallback` is always mounted, a plain `<img>` floats
 * on top. We bypass Radix's `AvatarImage` on purpose — its internal
 * `new Image()` always goes through an async "loading" state, which
 * causes a one-frame initials flash on every remount even when the
 * picture is already in the browser's cache. A plain `<img>` paints
 * cached images in the first frame, so workspace switches with the
 * same identity show the avatar instantly. On decode failure, `onError`
 * tears down the overlay and the fallback below stays visible. */
export const CachedAvatar = memo(function CachedAvatar({
	src,
	alt,
	fallback,
	fallbackClassName,
	imageClassName,
	...rootProps
}: CachedAvatarProps) {
	const resolvedSrc = useCachedAvatar(src);
	const [errored, setErrored] = useState(false);

	useEffect(() => {
		setErrored(false);
	}, [resolvedSrc]);

	return (
		<Avatar {...rootProps}>
			<AvatarFallback className={fallbackClassName}>{fallback}</AvatarFallback>
			{resolvedSrc && !errored ? (
				<img
					src={resolvedSrc}
					alt={alt}
					className={cn(
						"absolute inset-0 size-full rounded-[inherit] object-cover",
						imageClassName,
					)}
					onError={() => setErrored(true)}
				/>
			) : null}
		</Avatar>
	);
});
