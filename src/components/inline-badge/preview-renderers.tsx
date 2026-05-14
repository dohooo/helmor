import { convertFileSrc } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/ai/code-block";
import type { ComposerPreviewPayload } from "@/lib/composer-insert";

export type { ComposerPreviewPayload } from "@/lib/composer-insert";

export type InlineBadgePreviewEditHandlers = {
	onEditFocus: () => void;
	onEditBlur: (nextText: string) => void;
};

const PREVIEW_VIEWPORT_CLASS =
	"h-[min(60vh,520px)] overflow-y-auto overflow-x-hidden";
const EDITOR_VIEWPORT_CLASS = "h-[min(60vh,520px)]";

function resolveLocalPreviewSrc(path: string) {
	try {
		return convertFileSrc(path);
	} catch {
		return `asset://localhost${path}`;
	}
}

function PreviewFrame({
	title,
	children,
	bodyClassName,
}: {
	title: string;
	children: ReactNode;
	bodyClassName?: string;
}) {
	return (
		<div className="flex w-full min-w-0 flex-col">
			<div className="flex w-full min-w-0 items-center border-b border-border/40 px-3 py-2">
				<span className="block w-full min-w-0 truncate text-[12px] font-medium text-foreground">
					{title}
				</span>
			</div>
			<div className={bodyClassName}>{children}</div>
		</div>
	);
}

function EditableTextPreview({
	payload,
	editHandlers,
}: {
	payload: Extract<ComposerPreviewPayload, { kind: "text" }>;
	editHandlers: InlineBadgePreviewEditHandlers;
}) {
	const [draft, setDraft] = useState(payload.text);
	const draftRef = useRef(draft);
	draftRef.current = draft;

	// 外部 commit（onBlur 触发 lexical 更新）回流后,把本地 draft 同步成最新值。
	// 编辑过程中不会触发,因为按键只更新本地 state,不动 lexical。
	useEffect(() => {
		setDraft(payload.text);
	}, [payload.text]);

	return (
		<PreviewFrame
			title={payload.title}
			bodyClassName={`${EDITOR_VIEWPORT_CLASS} bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_84%,black_16%)_0%,var(--popover)_100%)]`}
		>
			<textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={editHandlers.onEditFocus}
				onBlur={() => editHandlers.onEditBlur(draftRef.current)}
				// 阻止冒泡到外层 Lexical 编辑器
				onKeyDown={(e) => e.stopPropagation()}
				onKeyUp={(e) => e.stopPropagation()}
				onPointerDown={(e) => e.stopPropagation()}
				className="block h-full w-full resize-none whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-3 font-mono text-[12px] leading-5 text-foreground/88 outline-none focus:outline-none"
				spellCheck={false}
			/>
		</PreviewFrame>
	);
}

/** Render a preview payload. Returns null when payload is null. */
export function renderInlineBadgePreview(
	payload: ComposerPreviewPayload | null,
	editHandlers?: InlineBadgePreviewEditHandlers | null,
): ReactNode {
	if (!payload) {
		return null;
	}
	switch (payload.kind) {
		case "image":
			return (
				<PreviewFrame
					title={payload.title}
					bodyClassName={`${PREVIEW_VIEWPORT_CLASS} flex items-center justify-center bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_85%,black_15%)_0%,var(--popover)_100%)] p-3`}
				>
					<img
						src={resolveLocalPreviewSrc(payload.path)}
						alt={payload.title}
						className="max-h-full max-w-full rounded-md object-contain shadow-sm"
					/>
				</PreviewFrame>
			);
		case "text":
			if (editHandlers) {
				return (
					<EditableTextPreview payload={payload} editHandlers={editHandlers} />
				);
			}
			return (
				<PreviewFrame
					title={payload.title}
					bodyClassName={`${PREVIEW_VIEWPORT_CLASS} bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_84%,black_16%)_0%,var(--popover)_100%)] px-3 py-3`}
				>
					<pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground/88">
						{payload.text}
					</pre>
				</PreviewFrame>
			);
		case "code":
			return (
				<PreviewFrame
					title={payload.title}
					bodyClassName={`${PREVIEW_VIEWPORT_CLASS} bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_84%,black_16%)_0%,var(--popover)_100%)]`}
				>
					<CodeBlock
						code={payload.code}
						language={payload.language}
						wrapLines
						variant="plain"
						className="w-full min-w-0"
					/>
				</PreviewFrame>
			);
	}
}

/** Placeholder frame used when a lazy preview fails to load. */
export function PreviewErrorFrame({ title }: { title: string }) {
	return (
		<PreviewFrame
			title={title}
			bodyClassName="flex items-center justify-center px-4 py-6"
		>
			<span className="text-[12px] text-muted-foreground">
				Unable to preview
			</span>
		</PreviewFrame>
	);
}

/** Placeholder frame used while a lazy preview is still loading. */
export function PreviewLoadingFrame({ title }: { title: string }) {
	return (
		<PreviewFrame
			title={title}
			bodyClassName="flex items-center justify-center px-4 py-6"
		>
			<span className="text-[12px] text-muted-foreground">Loading…</span>
		</PreviewFrame>
	);
}
