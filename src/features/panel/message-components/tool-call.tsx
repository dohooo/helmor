import { getMaterialFileIcon } from "file-extension-icon-js";
import {
	AlertCircle,
	Check,
	ChevronDown,
	FileText,
	LoaderCircle,
	Search,
	Terminal,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai/reasoning";
import { Button } from "@/components/ui/button";
import type { ExtendedMessagePart, ToolCallPart } from "@/lib/api";
import { childrenStructurallyEqual } from "@/lib/structural-equality";
import { cn } from "@/lib/utils";
import { TodoList } from "./content-parts";
import { EditDiffTrigger } from "./edit-diff";
import {
	isLiveStreamingStatus,
	isTodoListPart,
	isToolCallPart,
} from "./shared";
import { getToolInfo } from "./tool-info";

// --- props & equality ---

type AssistantToolCallProps = {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
	streamingStatus?: string;
	compact?: boolean;
	childParts?: ExtendedMessagePart[];
};

function shallowArgsEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	if (a === b) {
		return true;
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) {
		return false;
	}
	for (const key of keysA) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}

export function assistantToolCallPropsEqual(
	prev: AssistantToolCallProps,
	next: AssistantToolCallProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		prev.result === next.result &&
		prev.isError === next.isError &&
		prev.compact === next.compact &&
		childrenStructurallyEqual(prev.childParts, next.childParts) &&
		shallowArgsEqual(prev.args, next.args)
	);
}

// --- AssistantToolCall ---

export const AssistantToolCall = memo(function AssistantToolCall({
	toolName,
	args,
	result,
	isError,
	streamingStatus,
	compact = false,
	childParts,
}: AssistantToolCallProps) {
	const info = getToolInfo(toolName, args);
	const isEdit = toolName === "Edit";
	const isApplyPatch = toolName === "apply_patch";
	const oldStr =
		isEdit && typeof args.old_string === "string" ? args.old_string : null;
	const newStr =
		isEdit && typeof args.new_string === "string" ? args.new_string : null;
	const unifiedDiff =
		isApplyPatch && typeof info.rawDiff === "string" ? info.rawDiff : null;
	const hasDiff = oldStr != null || newStr != null || unifiedDiff != null;
	const hasFiles = (info.files?.length ?? 0) > 0;
	const suppressGenericPatchResult =
		isApplyPatch &&
		hasFiles &&
		(result === "Patch applied" || result === "Patch failed");

	const resultStr = useMemo(
		() =>
			result != null
				? typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)
				: null,
		[result],
	);
	const hasChildren = (childParts?.length ?? 0) > 0;
	const resultText =
		hasChildren || suppressGenericPatchResult ? null : (info.body ?? resultStr);
	const hasOutput = resultText != null && resultText.length > 5;
	const canExpand = hasOutput || hasFiles;
	const isLiveTool = isLiveStreamingStatus(streamingStatus);
	const [isOpen, setIsOpen] = useState(isLiveTool || hasFiles);
	useEffect(() => {
		if (isLiveTool) {
			setIsOpen(true);
			return;
		}
		if (!canExpand) {
			setIsOpen(false);
		}
	}, [canExpand, isLiveTool]);

	const statusIndicator = isLiveTool ? (
		<LoaderCircle
			className="size-3 animate-spin text-muted-foreground/50"
			strokeWidth={2}
		/>
	) : streamingStatus === "error" ? (
		<AlertCircle className="size-3 text-destructive" strokeWidth={2} />
	) : null;

	const toolLine = (
		<>
			<span className="shrink-0">{info.icon}</span>
			<span className="shrink-0 whitespace-nowrap font-medium">
				{info.action}
			</span>
			{info.file ? (
				hasDiff ? (
					<EditDiffTrigger
						file={info.file}
						diffAdd={info.diffAdd}
						diffDel={info.diffDel}
						oldStr={oldStr}
						newStr={newStr}
						unifiedDiff={unifiedDiff}
						icon={
							<img
								src={getMaterialFileIcon(info.file)}
								alt=""
								className="size-4 shrink-0"
							/>
						}
					/>
				) : (
					<>
						<img
							src={getMaterialFileIcon(info.file)}
							alt=""
							className="size-4 shrink-0"
						/>
						<span className="truncate text-muted-foreground">{info.file}</span>
					</>
				)
			) : null}
			{!hasDiff &&
			!hasFiles &&
			(info.diffAdd != null || info.diffDel != null) ? (
				<span className="flex items-center gap-1 text-[11px]">
					{info.diffAdd != null ? (
						<span className="text-chart-2">+{info.diffAdd}</span>
					) : null}
					{info.diffDel != null ? (
						<span className="text-destructive">-{info.diffDel}</span>
					) : null}
				</span>
			) : null}
			{info.command ? (
				<code className="inline-block min-w-0 truncate rounded bg-accent/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
					{info.command}
				</code>
			) : info.detail ? (
				<span className="min-w-0 truncate text-muted-foreground/60">
					{info.detail}
				</span>
			) : null}
			{statusIndicator}
		</>
	);

	if (hasChildren && childParts) {
		return (
			<AgentChildrenBlock
				toolName={toolName}
				toolArgs={args}
				streamingStatus={streamingStatus}
				isRunning={result == null}
				parts={childParts}
			/>
		);
	}

	if (compact) {
		const detail = info.file ?? info.command ?? info.detail ?? null;
		return (
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
				<span className="shrink-0">{info.icon}</span>
				<span className="shrink-0 font-medium">{info.action}</span>
				{detail ? (
					<span className="truncate text-muted-foreground">{detail}</span>
				) : null}
			</div>
		);
	}

	return (
		<>
			<details
				className="group/out flex flex-col"
				onToggle={(event) => {
					setIsOpen(event.currentTarget.open);
				}}
				open={isLiveTool || isOpen}
			>
				<summary
					className={cn(
						"flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground [&::-webkit-details-marker]:hidden",
						canExpand ? "cursor-pointer" : "cursor-default",
					)}
				>
					{toolLine}
					{canExpand ? (
						<span className="shrink-0 cursor-pointer text-muted-foreground/40 hover:text-muted-foreground">
							<svg
								className="size-2.5 group-open/out:rotate-90"
								viewBox="0 0 12 12"
								fill="none"
							>
								<path
									d="M4.5 2.5L8.5 6L4.5 9.5"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
					) : null}
				</summary>
				{canExpand && (isLiveTool || isOpen) ? (
					<div className="flex flex-col gap-1">
						{hasOutput ? (
							<div className="max-h-[16rem] overflow-auto rounded-md bg-accent/35 text-[11px] leading-5">
								{info.fullCommand ? (
									<div className="border-b border-border/20 px-2 py-1.5">
										<span className="mr-1.5 text-chart-3/70">$</span>
										<code className="font-mono text-muted-foreground">
											{info.fullCommand}
										</code>
									</div>
								) : null}
								<pre className="whitespace-pre-wrap break-words p-1.5 text-muted-foreground/80">
									{resultText!.slice(0, 2000)}
									{resultText!.length > 2000 ? "…" : ""}
								</pre>
							</div>
						) : null}
						{hasFiles ? (
							<div className="ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3">
								{info.files!.map((f, i) =>
									f.rawDiff ? (
										<EditDiffTrigger
											key={`${f.name}-${i}`}
											file={f.name}
											diffAdd={f.diffAdd}
											diffDel={f.diffDel}
											oldStr={null}
											newStr={null}
											unifiedDiff={f.rawDiff}
											variant="row"
											icon={
												<img
													src={getMaterialFileIcon(f.name)}
													alt=""
													className="size-3.5 shrink-0"
												/>
											}
										/>
									) : (
										<div
											key={`${f.name}-${i}`}
											className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[12px] leading-4 text-muted-foreground transition-colors hover:bg-accent/60"
										>
											<img
												src={getMaterialFileIcon(f.name)}
												alt=""
												className="size-3.5 shrink-0"
											/>
											<span className="min-w-0 truncate">{f.name}</span>
											{f.diffAdd != null || f.diffDel != null ? (
												<span className="flex shrink-0 items-center gap-1 text-[11px]">
													{f.diffAdd != null ? (
														<span className="text-chart-2">+{f.diffAdd}</span>
													) : null}
													{f.diffDel != null ? (
														<span className="text-destructive">
															-{f.diffDel}
														</span>
													) : null}
												</span>
											) : null}
										</div>
									),
								)}
							</div>
						) : null}
					</div>
				) : null}
			</details>
			{isError === true ? <ToolCallErrorRow result={result} /> : null}
		</>
	);
}, assistantToolCallPropsEqual);

// --- ToolCallErrorRow ---

type ToolError = {
	exitCode: number | null;
	preview: string | null;
	full: string | null;
};

const EXIT_CODE_RE = /^Exit code:?\s+(\d+)\s*\n?/;
const TOOL_USE_ERROR_RE = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/;

function extractToolError(result: unknown): ToolError | null {
	if (typeof result !== "string") {
		return null;
	}
	let body = result.trim();
	if (!body) {
		return null;
	}

	let exitCode: number | null = null;
	const exitMatch = body.match(EXIT_CODE_RE);
	if (exitMatch) {
		const parsed = Number.parseInt(exitMatch[1], 10);
		if (Number.isFinite(parsed) && parsed !== 0) {
			exitCode = parsed;
		}
		body = body.slice(exitMatch[0].length).trim();
	}

	const wrapMatch = body.match(TOOL_USE_ERROR_RE);
	if (wrapMatch) {
		body = wrapMatch[1].trim();
	}

	body = body.replace(/^Error:\s*/i, "").trim();

	if (exitCode == null && !body) {
		return null;
	}
	const preview = body ? previewLine(body) : null;
	return {
		exitCode,
		preview,
		full: body.length > 0 ? body : null,
	};
}

function previewLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
		}
	}
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

const ToolCallErrorRow = memo(function ToolCallErrorRow({
	result,
}: {
	result: unknown;
}) {
	const error = useMemo(() => extractToolError(result), [result]);
	const [open, setOpen] = useState(false);
	if (!error) {
		return null;
	}
	const { exitCode, preview, full } = error;
	const expandable = full != null;
	return (
		<details
			className="group/err flex flex-col"
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
			open={open}
		>
			<summary
				className={cn(
					"flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-destructive [&::-webkit-details-marker]:hidden",
					expandable ? "cursor-pointer" : "cursor-default",
				)}
			>
				<AlertCircle className="size-3.5 shrink-0" strokeWidth={1.8} />
				<span className="shrink-0 font-medium">Error</span>
				{exitCode != null ? (
					<code className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px]">
						Exit code {exitCode}
					</code>
				) : null}
				{preview ? (
					<span className="min-w-0 truncate font-mono text-[11px] text-destructive/80">
						{preview}
					</span>
				) : null}
				{expandable ? (
					<span className="shrink-0 cursor-pointer text-destructive/40 hover:text-destructive">
						<svg
							className="size-2.5 group-open/err:rotate-90"
							viewBox="0 0 12 12"
							fill="none"
						>
							<path
								d="M4.5 2.5L8.5 6L4.5 9.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
				) : null}
			</summary>
			{expandable && open ? (
				<div className="mt-0.5 max-h-[16rem] overflow-auto rounded-md border border-destructive/15 bg-destructive/[0.05] text-[11px] leading-5">
					<pre className="whitespace-pre-wrap break-words p-1.5 text-destructive/80">
						{full!.slice(0, 4000)}
						{full!.length > 4000 ? "…" : ""}
					</pre>
				</div>
			) : null}
		</details>
	);
});

// --- AgentChildrenBlock ---

const AGENT_PREVIEW_STEPS = 3;

type AgentChildrenBlockProps = {
	toolName: string;
	toolArgs: Record<string, unknown>;
	streamingStatus?: string;
	isRunning?: boolean;
	parts: ExtendedMessagePart[];
};

export function agentChildrenBlockPropsEqual(
	prev: AgentChildrenBlockProps,
	next: AgentChildrenBlockProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		prev.isRunning === next.isRunning &&
		childrenStructurallyEqual(prev.parts, next.parts) &&
		shallowArgsEqual(prev.toolArgs, next.toolArgs)
	);
}

const AgentChildrenBlock = memo(function AgentChildrenBlock({
	toolName,
	toolArgs,
	streamingStatus,
	isRunning,
	parts,
}: AgentChildrenBlockProps) {
	const [expanded, setExpanded] = useState(false);
	const isLive = isLiveStreamingStatus(streamingStatus);
	const streaming = isLive || (!streamingStatus && !!isRunning);
	const info = getToolInfo(toolName, toolArgs);
	const toolCallParts = useMemo(
		() =>
			parts.filter((part): part is ToolCallPart => part.type === "tool-call"),
		[parts],
	);
	const toolUseCount = toolCallParts.length;
	const visibleParts: ExtendedMessagePart[] = expanded
		? parts
		: toolCallParts.slice(-AGENT_PREVIEW_STEPS);
	const collapsedVisibleCount = Math.min(
		toolCallParts.length,
		AGENT_PREVIEW_STEPS,
	);
	const hiddenCount = parts.length - collapsedVisibleCount;
	const hasMore =
		toolCallParts.length >= AGENT_PREVIEW_STEPS && hiddenCount > 0;
	const canToggle = hasMore && (expanded || !streaming);

	return (
		<div className="flex flex-col">
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
				<span className="shrink-0">{info.icon}</span>
				<span className="font-medium">{info.action}</span>
				{info.detail ? (
					<span className="truncate text-muted-foreground/60">
						{info.detail}
					</span>
				) : null}
				{streaming ? (
					<LoaderCircle
						className="size-3 animate-spin text-muted-foreground/50"
						strokeWidth={2}
					/>
				) : null}
				<span className="shrink-0 text-[11px] text-muted-foreground/40">
					{toolUseCount > 0
						? `${toolUseCount} tool ${toolUseCount === 1 ? "use" : "uses"}`
						: `${parts.length} steps`}
				</span>
			</div>

			<div className="ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3 pt-1">
				{canToggle ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => setExpanded((value) => !value)}
						className="mb-0.5 h-auto items-center justify-start gap-1 px-0 text-[11px] text-muted-foreground/50 hover:bg-transparent hover:text-muted-foreground"
					>
						<ChevronDown
							className={cn(
								"size-3 transition-transform",
								expanded && "rotate-180",
							)}
							strokeWidth={1.5}
						/>
						{expanded
							? "Collapse"
							: `Show ${hiddenCount} more step${hiddenCount > 1 ? "s" : ""}`}
					</Button>
				) : null}

				<div className="flex flex-col gap-0.5">
					{visibleParts.map((part, index) => {
						if (isToolCallPart(part)) {
							return (
								<AssistantToolCall
									key={part.toolCallId ?? `tool-${index}`}
									toolName={part.toolName ?? "unknown"}
									args={part.args ?? {}}
									result={part.result}
									isError={part.isError}
									compact={!expanded}
									childParts={part.children}
								/>
							);
						}
						if (part.type === "text" && part.text) {
							return (
								<div
									key={`text-${index}`}
									className="text-[13px] leading-6 text-muted-foreground"
								>
									{part.text.slice(0, 300)}
									{part.text.length > 300 ? "…" : ""}
								</div>
							);
						}
						if (part.type === "reasoning" && part.text) {
							return (
								<Reasoning key={`reason-${index}`}>
									<ReasoningTrigger />
									<ReasoningContent>{part.text}</ReasoningContent>
								</Reasoning>
							);
						}
						if (isTodoListPart(part)) {
							return <TodoList key={`todo-${index}`} part={part} />;
						}
						return null;
					})}
				</div>
			</div>
		</div>
	);
}, agentChildrenBlockPropsEqual);

// --- CollapsedToolGroup ---

export function CollapsedToolGroup({
	group,
}: {
	group: import("@/lib/api").CollapsedGroupPart;
}) {
	const [open, setOpen] = useState(group.active);
	useEffect(() => {
		setOpen(group.active);
	}, [group.active]);
	const collapsedGroupIconClassName = "size-3.5 text-muted-foreground";

	const icon =
		group.category === "search" ? (
			<Search className={collapsedGroupIconClassName} strokeWidth={1.8} />
		) : group.category === "shell" ? (
			<Terminal className={collapsedGroupIconClassName} strokeWidth={1.8} />
		) : (
			<FileText className={collapsedGroupIconClassName} strokeWidth={1.8} />
		);

	return (
		<details
			className="group/collapse flex flex-col"
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
			open={open}
		>
			<summary className="flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className="shrink-0">{icon}</span>
				<span className="font-medium">{group.summary}</span>
				{group.active ? (
					<LoaderCircle
						className="size-3 animate-spin text-chart-2"
						strokeWidth={2}
					/>
				) : (
					<Check className="size-3 text-chart-2" strokeWidth={2} />
				)}
				<span className="shrink-0 cursor-pointer text-muted-foreground/40 hover:text-muted-foreground">
					<svg
						className="size-2.5 group-open/collapse:rotate-90"
						viewBox="0 0 12 12"
						fill="none"
					>
						<path
							d="M4.5 2.5L8.5 6L4.5 9.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground/40">
					{group.tools.length} tools
				</span>
			</summary>
			{open ? (
				<div className="ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3 pt-1">
					{group.tools.map((tool, index) => (
						<AssistantToolCall
							key={tool.toolCallId ?? `${tool.toolName}:${index}`}
							toolName={tool.toolName}
							args={tool.args}
							result={tool.result}
							isError={tool.isError}
						/>
					))}
				</div>
			) : null}
		</details>
	);
}
