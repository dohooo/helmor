import { useQuery } from "@tanstack/react-query";
import { cacheForgeAvatar } from "./api";
import { convertLocalFileSrc } from "./ipc";
import { PERSIST_META } from "./query-client";

const AVATAR_CACHE_QUERY_VERSION = "local-v2";

/** Resolves a remote avatar URL to a local `asset://` URL backed by an
 * on-disk cache. First call downloads + writes to disk; every later call
 * (across mounts and across app restarts) returns the cached path
 * synchronously, which removes the HTTP round trip and the per-mount
 * decode that causes fallback letters to flash on page navigations.
 *
 * Returns:
 * - `null` when no URL exists
 * - local URLs as-is
 * - the `asset://...` URL on cache success
 * - the original remote URL while the cache lookup is in flight, and on
 *   cache failure, so the browser can paint from its own HTTP cache instead
 *   of waiting for the disk-cache IPC round trip
 */
export function useCachedAvatar(url: string | null | undefined): string | null {
	const trimmed = url?.trim() ?? "";
	const skipCache = !trimmed || isAlreadyLocal(trimmed);

	const query = useQuery({
		queryKey: ["cachedAvatar", AVATAR_CACHE_QUERY_VERSION, trimmed],
		queryFn: () => cacheForgeAvatar(trimmed),
		enabled: !skipCache,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 0,
		meta: PERSIST_META,
	});

	if (!trimmed) {
		return null;
	}
	if (skipCache) {
		return trimmed;
	}
	if (query.data) {
		return convertLocalFileSrc(query.data);
	}
	return trimmed;
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
