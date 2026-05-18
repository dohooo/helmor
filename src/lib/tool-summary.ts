import type { ToolCallPart } from "./api";

/** Strip path → basename. Tolerant of forward + back slashes. */
export function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * One-line text summary of a tool call. Shared between the sidebar
 * hover card and any other surface that needs a compact, scannable
 * label without the panel's rich icon rendering.
 */
export function summarizeToolCall(part: ToolCallPart): string {
	const args = part.args ?? {};
	const filePath = typeof args.file_path === "string" ? args.file_path : null;
	const path = typeof args.path === "string" ? args.path : null;
	const command = typeof args.command === "string" ? args.command : null;
	const pattern = typeof args.pattern === "string" ? args.pattern : null;
	const url = typeof args.url === "string" ? args.url : null;
	const query = typeof args.query === "string" ? args.query : null;
	const file = filePath ?? path;

	switch (part.toolName) {
		case "Read":
			return file ? `Reading ${basename(file)}` : "Reading file";
		case "Edit":
			return file ? `Editing ${basename(file)}` : "Editing file";
		case "Write":
			return file ? `Writing ${basename(file)}` : "Writing file";
		case "apply_patch":
			return "Applying patch";
		case "Bash":
			return command ? `$ ${command.slice(0, 80)}` : "Running shell";
		case "Grep":
			return pattern ? `Grep "${pattern}"` : "Searching";
		case "Glob":
			return pattern ? `Glob ${pattern}` : "Listing files";
		case "WebFetch":
			return url ? `Fetching ${url}` : "Fetching URL";
		case "WebSearch":
			return query ? `Searching "${query}"` : "Web search";
		case "Task":
		case "Agent":
			return "Running sub-agent";
		case "TodoWrite":
			return "Updating todos";
		default: {
			if (part.toolName.startsWith("mcp__")) {
				const segments = part.toolName.split("__");
				const tool = segments.slice(2).join("__") || part.toolName;
				return `MCP ${tool}`;
			}
			return part.toolName;
		}
	}
}
