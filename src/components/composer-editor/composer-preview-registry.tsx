import { convertFileSrc } from "@tauri-apps/api/core";
import type { ReactNode } from "react";

export type ComposerPreviewPayload = {
	kind: "image";
	title: string;
	path: string;
};

type PreviewRenderer<
	T extends ComposerPreviewPayload = ComposerPreviewPayload,
> = (payload: T) => ReactNode;

function resolveLocalPreviewSrc(path: string) {
	try {
		return convertFileSrc(path);
	} catch {
		return `asset://localhost${path}`;
	}
}

const previewRenderers: {
	[K in ComposerPreviewPayload["kind"]]: PreviewRenderer<
		Extract<ComposerPreviewPayload, { kind: K }>
	>;
} = {
	image: (payload) => (
		<div className="flex flex-col">
			<div className="flex items-center border-b border-border/40 px-3 py-2">
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
					{payload.title}
				</span>
			</div>
			<div className="flex max-h-[360px] items-center justify-center bg-[linear-gradient(180deg,color-mix(in_oklch,var(--sidebar)_85%,black_15%)_0%,var(--popover)_100%)] p-2">
				<img
					src={resolveLocalPreviewSrc(payload.path)}
					alt={payload.title}
					className="max-h-[340px] max-w-full rounded-md object-contain shadow-sm"
				/>
			</div>
		</div>
	),
};

export function renderComposerPreview(payload: ComposerPreviewPayload | null) {
	if (!payload) {
		return null;
	}

	const renderer = previewRenderers[payload.kind];
	return renderer ? renderer(payload as never) : null;
}
