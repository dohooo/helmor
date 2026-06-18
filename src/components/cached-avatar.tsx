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

/** Avatar with on-disk URL caching + an error-only initials fallback.
 *
 * A plain `<img>` floats on top. We bypass Radix's `AvatarImage` on purpose —
 * its internal `new Image()` always goes through an async "loading" state,
 * which causes a one-frame initials flash on every remount even when the
 * picture is already in the browser's cache. While a real src is pending, keep
 * the initials hidden; if decode fails, `onError` tears down the overlay and
 * reveals the fallback. */
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
			<AvatarFallback
				className={cn(
					resolvedSrc && !errored && "opacity-0",
					fallbackClassName,
				)}
			>
				{fallback}
			</AvatarFallback>
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
