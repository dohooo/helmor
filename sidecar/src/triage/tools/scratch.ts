// Agent-facing tools for navigating the per-tick scratch directory.

import { Type } from "@earendil-works/pi-ai";
import type { ScratchSession } from "../scratch";

export function buildScratchTools(scratch: ScratchSession) {
	const listFiles = {
		name: "scratch_list",
		label: "Scratch · List Files",
		description:
			"List every Markdown file written into the scratch workspace by source tools. Returns filename, size, line count and the top-level title for each. Always cheap — call before grep/read to find what's available.",
		parameters: Type.Object({}),
		execute: async () => {
			const entries = await scratch.list();
			if (entries.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "(scratch is empty — fetch from a source first)",
						},
					],
					details: { entries: [] },
				};
			}
			const lines = entries.map(
				(e) =>
					`- ${e.file} — ${e.bytes}B / ${e.lines} lines — ${e.title ?? "(no title)"}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { entries },
			};
		},
	};

	const grep = {
		name: "scratch_grep",
		label: "Scratch · Grep",
		description:
			"Search across scratch Markdown files with a JS regex pattern. Returns matching lines with surrounding context. Use this to find a sender name, keyword, repo id, or message id without loading whole files into context.",
		parameters: Type.Object({
			pattern: Type.String({
				description:
					"JS regex pattern, e.g. `夏云`, `bug|fix|修`, `ou_[a-z0-9]+`. Case-sensitive unless ignore_case=true.",
			}),
			file: Type.Optional(
				Type.String({
					description:
						"Restrict to one file (filename only, no path). Omit to search all files.",
				}),
			),
			context: Type.Optional(
				Type.Integer({
					description:
						"Lines of context before+after each match (0-10, default 2).",
				}),
			),
			max_matches: Type.Optional(
				Type.Integer({
					description: "Cap on returned matches (1-200, default 50).",
				}),
			),
			ignore_case: Type.Optional(
				Type.Boolean({ description: "Case-insensitive match." }),
			),
		}),
		execute: async (
			_id: string,
			params: {
				pattern: string;
				file?: string;
				context?: number;
				max_matches?: number;
				ignore_case?: boolean;
			},
		) => {
			const result = await scratch.grep(params.pattern, {
				file: params.file,
				context: params.context,
				maxMatches: params.max_matches,
				ignoreCase: params.ignore_case,
			});
			if (result.matches.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `(no matches in ${result.filesScanned} file(s))`,
						},
					],
					details: result,
				};
			}
			const body = result.matches
				.map((m) => `### ${m.file}:${m.line}\n\`\`\`\n${m.context}\n\`\`\``)
				.join("\n\n");
			const header = `Found ${result.matches.length}${result.truncated ? "+" : ""} match(es) in ${result.filesScanned} file(s):\n\n`;
			return {
				content: [{ type: "text" as const, text: header + body }],
				details: result,
			};
		},
	};

	const read = {
		name: "scratch_read",
		label: "Scratch · Read File",
		description:
			"Read a slice of one scratch file. Use after grep/list to inspect a specific section. Always slice — files can be large.",
		parameters: Type.Object({
			file: Type.String({
				description: "Filename from scratch_list (no path).",
			}),
			offset: Type.Optional(
				Type.Integer({
					description: "0-based line offset to start at (default 0).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description: "How many lines to return (1-2000, default 400).",
				}),
			),
		}),
		execute: async (
			_id: string,
			params: { file: string; offset?: number; limit?: number },
		) => {
			const r = await scratch.read(params.file, {
				offset: params.offset,
				limit: params.limit,
			});
			const header = `# ${params.file} — lines ${r.startLine}-${r.endLine} of ${r.totalLines}\n\n`;
			return {
				content: [{ type: "text" as const, text: header + r.content }],
				details: {
					file: params.file,
					startLine: r.startLine,
					endLine: r.endLine,
					totalLines: r.totalLines,
				},
			};
		},
	};

	return [listFiles, grep, read];
}
