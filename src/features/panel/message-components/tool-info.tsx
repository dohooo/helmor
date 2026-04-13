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
	SquareTerminal,
} from "lucide-react";
import type { ToolInfo } from "./shared";
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
			icon: (
				<SquareTerminal
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
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
		const query = str(input.query);
		return {
			action: "WebSearch",
			icon: <Globe className={neutralToolIconClassName} strokeWidth={1.8} />,
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
			action: "Plan mode",
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
