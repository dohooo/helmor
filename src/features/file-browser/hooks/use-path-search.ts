import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { workspacePathSearchQueryOptions } from "@/lib/query-client";

/**
 * Debounces `rawQuery` and feeds it into `workspacePathSearchQueryOptions`.
 * Disabled when the workspace root is missing or the query is whitespace-only,
 * so we don't fire a no-op IPC.
 */
export function usePathSearch(
	workspaceRootPath: string | null,
	rawQuery: string,
	debounceMs = 150,
) {
	const [debounced, setDebounced] = useState(rawQuery);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(rawQuery), debounceMs);
		return () => clearTimeout(t);
	}, [rawQuery, debounceMs]);

	return useQuery({
		...workspacePathSearchQueryOptions(workspaceRootPath ?? "", debounced),
		enabled: Boolean(workspaceRootPath) && debounced.trim().length > 0,
	});
}
