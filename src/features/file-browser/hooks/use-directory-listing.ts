import { useQuery } from "@tanstack/react-query";

import { workspaceDirectoryQueryOptions } from "@/lib/query-client";

export function useDirectoryListing(
	workspaceRootPath: string | null,
	relativePath: string,
	enabled = true,
) {
	return useQuery({
		...workspaceDirectoryQueryOptions(workspaceRootPath ?? "", relativePath),
		enabled: enabled && Boolean(workspaceRootPath),
	});
}
