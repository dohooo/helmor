import { convertFileSrc } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ai/code-block";
import type { ComposerPreviewPayload } from "@/lib/composer-insert";

export type { ComposerPreviewPayload } from "@/lib/composer-insert";

type PreviewRenderer<
	T extends ComposerPreviewPayload = ComposerPreviewPayload,
> = (payload: T) => ReactNode;

const PREVIEW_VIEWPORT_CLASS =
	"h-[min(60vh,520px)] overflow-y-auto overflow-x-hidden";

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

const previewRenderers: {
	[K in ComposerPreviewPayload["kind"]]: PreviewRenderer<
		Extract<ComposerPreviewPayload, { kind: K }>
	>;
} = {
	image: (payload) => (
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
	),
	text: (payload) => (
		<PreviewFrame
			title={payload.title}
			bodyClassName={`${PREVIEW_VIEWPORT_CLASS} bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_84%,black_16%)_0%,var(--popover)_100%)] px-3 py-3`}
		>
			<pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground/88">
				{payload.text}
			</pre>
		</PreviewFrame>
	),
	code: (payload) => (
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
	),
};

export function renderComposerPreview(payload: ComposerPreviewPayload | null) {
	if (!payload) {
		return null;
	}

	return previewRenderers[payload.kind](payload as never);
}
