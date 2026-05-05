import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cacheForgeAvatar } from "./api";

/** Resolves a remote avatar URL to a local `asset://` URL backed by an
 * on-disk cache. First call downloads + writes to disk; every later call
 * (across mounts and across app restarts) returns the cached path
 * synchronously, which removes the HTTP round trip and the per-mount
 * decode that causes fallback letters to flash on page navigations.
 *
 * Returns:
 * - `null` while the cache lookup is in flight (component renders empty)
 * - the `asset://...` URL on success
 * - the original `url` as a fallback on error (lets the browser try the
 *   network as a last resort)
 */
export function useCachedAvatar(url: string | null | undefined): string | null {
	const trimmed = url?.trim() ?? "";
	const skipCache = !trimmed || isAlreadyLocal(trimmed);

	const query = useQuery({
		queryKey: ["cachedAvatar", trimmed],
		queryFn: () => cacheForgeAvatar(trimmed),
		enabled: !skipCache,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 0,
	});

	if (!trimmed) {
		return null;
	}
	if (skipCache) {
		return trimmed;
	}
	if (query.data) {
		return convertFileSrc(query.data);
	}
	if (query.isError) {
		// On disk-cache failure, fall back to the original URL so the
		// avatar still has a chance to load over HTTP.
		return trimmed;
	}
	return null;
}

function isAlreadyLocal(url: string): boolean {
	return (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("asset:") ||
		url.startsWith("tauri:") ||
		url.startsWith("file:")
	);
}
