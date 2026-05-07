export function isSessionRunningStatus(status?: string | null): boolean {
	return (
		status === "pending" ||
		status === "streaming" ||
		status === "streaming_input" ||
		status === "running"
	);
}
