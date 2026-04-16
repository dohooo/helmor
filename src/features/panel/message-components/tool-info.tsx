import {
	Bot,
	ClipboardCheck,
	ClipboardList,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	MessageSquareMore,
	MessageSquareText,
	Pencil,
	Plug,
	Search,
	Terminal,
} from "lucide-react";
import type { FileChangeInfo, ToolInfo } from "./shared";
import { basename, isObj, str, truncate } from "./shared";

const fallbackIcon = (
	<span className="size-3.5 rounded-full bg-foreground/15" />
);
const neutralToolIconClassName = "size-3.5 text-muted-foreground";

export function getToolInfo(
	name: string,
	input: Record<string, unknown> | null,
): ToolInfo {
	if (name.startsWith("mcp__")) {
		const segments = name.split("__");
		const server = segments[1] ?? "mcp";
		const tool = segments.slice(2).join("__") || name;
		return {
			action: tool,
			icon: <Plug className="size-3.5 text-chart-2" strokeWidth={1.8} />,
			detail: `via ${server}`,
		};
	}

	if (!input) {
		return { action: name, icon: fallbackIcon };
	}

	if (name === "Edit") {
		const filePath = str(input.file_path);
		const oldStr = typeof input.old_string === "string" ? input.old_string : "";
		const newStr = typeof input.new_string === "string" ? input.new_string : "";
		const diffDelete = oldStr ? oldStr.split("\n").length : 0;
		const diffAdd = newStr ? newStr.split("\n").length : 0;
		return {
			action: "Edit",
			file: filePath ? basename(filePath) : undefined,
			icon: <Pencil className={neutralToolIconClassName} strokeWidth={1.8} />,
			diffAdd,
			diffDel: diffDelete,
		};
	}

	if (name === "apply_patch") {
		const changes = Array.isArray(input.changes) ? input.changes : [];
		const parsed = changes.filter(isObj).map((c) => {
			const path = str(c.path);
			const diff = typeof c.diff === "string" ? c.diff : "";
			let add = 0;
			let del = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) add++;
				else if (line.startsWith("-") && !line.startsWith("---")) del++;
			}
			return {
				name: path ? basename(path) : "unknown",
				diffAdd: add || undefined,
				diffDel: del || undefined,
				rawDiff: diff || undefined,
			} satisfies FileChangeInfo;
		});
		const totalAdd = parsed.reduce((s, f) => s + (f.diffAdd ?? 0), 0);
		const totalDel = parsed.reduce((s, f) => s + (f.diffDel ?? 0), 0);
		const icon = (
			<Pencil className={neutralToolIconClassName} strokeWidth={1.8} />
		);

		if (parsed.length <= 1) {
			return {
				action: "Edit",
				file: parsed[0]?.name,
				icon,
				diffAdd: totalAdd || undefined,
				diffDel: totalDel || undefined,
				rawDiff: parsed[0]?.rawDiff,
			};
		}
		return {
			action: `Edit ${parsed.length} files`,
			icon,
			diffAdd: totalAdd || undefined,
			diffDel: totalDel || undefined,
			files: parsed,
		};
	}

	if (name === "Read") {
		const filePath = str(input.file_path);
		const limit = typeof input.limit === "number" ? input.limit : null;
		return {
			action: limit ? `Read ${limit} lines` : "Read",
			file: filePath ? basename(filePath) : undefined,
			icon: <FileText className={neutralToolIconClassName} strokeWidth={1.8} />,
		};
	}

	if (name === "Write") {
		const filePath = str(input.file_path);
		return {
			action: "Write",
			file: filePath ? basename(filePath) : undefined,
			icon: <FilePlus className={neutralToolIconClassName} strokeWidth={1.8} />,
		};
	}

	if (name === "Bash") {
		const command = str(input.command);
		const description = str(input.description);
		return {
			action: description ?? "Run",
			icon: <Terminal className={neutralToolIconClassName} strokeWidth={1.8} />,
			command: command ? truncate(command, 80) : undefined,
			fullCommand: command ?? undefined,
		};
	}

	if (name === "Grep") {
		const pattern = str(input.pattern);
		return {
			action: "Grep",
			icon: <Search className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: pattern ?? undefined,
		};
	}

	if (name === "Glob") {
		const pattern = str(input.pattern);
		return {
			action: "Glob",
			icon: (
				<FolderSearch className={neutralToolIconClassName} strokeWidth={1.8} />
			),
			detail: pattern ?? undefined,
		};
	}

	if (name === "WebFetch") {
		const url = str(input.url);
		return {
			action: "WebFetch",
			icon: <Globe className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: url ? truncate(url, 60) : undefined,
		};
	}

	if (name === "WebSearch") {
		const icon = (
			<Globe className={neutralToolIconClassName} strokeWidth={1.8} />
		);
		const action = isObj(input.action) ? input.action : null;
		const actionType = action ? str(action.type) : null;
		if (actionType === "openPage") {
			const url = str(action!.url);
			return {
				action: "Open page",
				icon,
				detail: url ? truncate(url, 60) : undefined,
			};
		}
		if (actionType === "findInPage") {
			const pattern = str(action!.pattern) ?? str(action!.url);
			return {
				action: "Find in page",
				icon,
				detail: pattern ? truncate(pattern, 60) : undefined,
			};
		}
		const query = str(input.query);
		return {
			action: "WebSearch",
			icon,
			detail: query ? truncate(query, 50) : undefined,
		};
	}

	if (name === "ToolSearch") {
		const query = str(input.query);
		return {
			action: "ToolSearch",
			icon: <Search className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: query ? truncate(query, 50) : undefined,
		};
	}

	if (name === "Agent" || name === "Task") {
		const subagentType = str(input.subagent_type);
		const detail = str(input.description) ?? str(input.prompt);
		return {
			action: subagentType ?? name,
			icon: <Bot className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: detail ? truncate(detail, 60) : undefined,
		};
	}

	if (name === "Prompt") {
		const text = str(input.text);
		return {
			action: "Prompt",
			icon: (
				<MessageSquareText
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
			body: text ?? undefined,
		};
	}

	if (
		name === "AskUserQuestion" ||
		name === "askUserQuestions" ||
		name === "vscode_askQuestions"
	) {
		const questions = Array.isArray(input.questions) ? input.questions : [];
		const firstQuestion = questions[0];
		const detail =
			str(input.question) ??
			str(input.prompt) ??
			(isObj(firstQuestion)
				? (str(firstQuestion.question) ?? str(firstQuestion.header))
				: null);
		return {
			action: "Ask user",
			icon: (
				<MessageSquareMore
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
			detail: detail ? truncate(detail, 60) : undefined,
		};
	}

	if (name === "EnterPlanMode") {
		return {
			action: "Enter Plan mode",
			icon: (
				<ClipboardList className={neutralToolIconClassName} strokeWidth={1.8} />
			),
		};
	}

	if (name === "ExitPlanMode") {
		return {
			action: "Exit plan mode",
			icon: (
				<ClipboardCheck
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
		};
	}

	return { action: name, icon: fallbackIcon };
}
