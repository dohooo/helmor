export function EmptyChangesRow() {
	return (
		<div className="px-3 py-3 text-mini leading-5 text-muted-foreground">
			No changes on this branch yet.
		</div>
	);
}

export function LoadingChangesRow() {
	return (
		<div className="py-2 pr-2 pl-5 text-micro text-muted-foreground">
			Switching target branch...
		</div>
	);
}
