import { FileIcon } from "./file-icon";
import { usePathSearch } from "./hooks/use-path-search";

interface OpenFileInput {
	absolutePath: string;
	relativePath: string;
	fileName: string;
}

interface Props {
	workspaceRootPath: string | null;
	query: string;
	onOpenFile: (input: OpenFileInput) => void;
}

export function SearchResults({ workspaceRootPath, query, onOpenFile }: Props) {
	const { data, isLoading, isFetching } = usePathSearch(
		workspaceRootPath,
		query,
	);

	if (!query.trim()) return null;

	if (isLoading || isFetching) {
		return (
			<div className="px-2 py-2 text-[11.5px] text-muted-foreground">
				Searching…
			</div>
		);
	}

	if (!data || data.length === 0) {
		return (
			<div className="px-2 py-2 text-[11.5px] text-muted-foreground">
				No matches.
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			{data.map((hit) => (
				<button
					key={hit.absolutePath}
					type="button"
					onClick={() =>
						onOpenFile({
							absolutePath: hit.absolutePath,
							relativePath: hit.path,
							fileName: hit.name,
						})
					}
					className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-[12.5px] hover:bg-accent"
				>
					<FileIcon name={hit.name} kind={hit.kind} />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate">{hit.name}</span>
						{hit.path !== hit.name ? (
							<span className="truncate text-[10.5px] text-muted-foreground">
								{hit.path}
							</span>
						) : null}
					</div>
				</button>
			))}
		</div>
	);
}
