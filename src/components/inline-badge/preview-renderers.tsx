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
				<span className="block w-full min-w-0 truncate text-small font-medium text-foreground">
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

	// Re-sync the local draft once an external commit (lexical update from
	// onBlur) flows back in. Doesn't fire mid-edit because keystrokes only
	// touch local state, not lexical.
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
				// Stop events from bubbling to the outer Lexical editor
				onKeyDown={(e) => e.stopPropagation()}
				onKeyUp={(e) => e.stopPropagation()}
				onPointerDown={(e) => e.stopPropagation()}
				className="block h-full w-full resize-none whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-3 font-mono text-small leading-5 text-foreground/88 outline-none focus:outline-none"
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
					<pre className="whitespace-pre-wrap break-words font-mono text-small leading-5 text-foreground/88">
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
			<span className="text-small text-muted-foreground">
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
			<span className="text-small text-muted-foreground">Loading…</span>
		</PreviewFrame>
	);
}
