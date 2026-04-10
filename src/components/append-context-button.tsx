import { LayersPlus, LoaderCircle } from "lucide-react";
import { useCallback, useState } from "react";
import type {
	ComposerInsertItem,
	ComposerInsertRequest,
	ComposerInsertTarget,
	ComposerPreviewPayload,
} from "@/lib/composer-insert";
import { buildComposerPreviewInsertItem } from "@/lib/composer-insert";
import { useComposerInsert } from "@/lib/composer-insert-context";
import { cn } from "@/lib/utils";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { Button } from "./ui/button";

export type AppendContextTagPayload = {
	target?: ComposerInsertTarget;
	label: string;
	submitText: string;
	key?: string;
	preview?: ComposerPreviewPayload | null;
};

export type AppendContextRequestPayload = {
	target?: ComposerInsertTarget;
	items: ComposerInsertItem[];
	behavior?: ComposerInsertRequest["behavior"];
};

export type AppendContextPayload =
	| AppendContextTagPayload
	| AppendContextRequestPayload;

type MaybePromise<T> = T | Promise<T>;

export type AppendContextPayloadResult =
	| AppendContextPayload
	| null
	| undefined;

export type AppendContextButtonProps = {
	subjectLabel: string;
	/** Builds the payload to inject. Return a single custom tag for the common
	 * case, or a full ComposerInsertRequest shape when the caller needs more
	 * control. Supports sync and async producers. */
	getPayload: () => MaybePromise<AppendContextPayloadResult>;
	ariaLabel?: string;
	errorTitle?: string;
	disabled?: boolean;
	className?: string;
	onInserted?: () => void;
};

function normalizeAppendContextPayload(
	payload: AppendContextPayload,
): ComposerInsertRequest {
	if ("items" in payload) {
		return {
			target: payload.target,
			items: payload.items,
			behavior: payload.behavior ?? "append",
		};
	}

	if (payload.preview) {
		return {
			target: payload.target,
			items: [
				{
					kind: "custom-tag",
					label: payload.label,
					submitText: payload.submitText,
					key: payload.key,
					preview: payload.preview,
				},
			],
			behavior: "append",
		};
	}

	const previewInsertItem = buildComposerPreviewInsertItem({
		content: payload.submitText,
		label: payload.label,
		key: payload.key,
	});

	if (!previewInsertItem) {
		return {
			target: payload.target,
			items: [{ kind: "text", text: payload.submitText }],
			behavior: "append",
		};
	}

	return {
		target: payload.target,
		items: [previewInsertItem],
		behavior: "append",
	};
}

export function AppendContextButton({
	subjectLabel,
	getPayload,
	ariaLabel,
	errorTitle = "Couldn't append context",
	disabled = false,
	className,
	onInserted,
}: AppendContextButtonProps) {
	const insertIntoComposer = useComposerInsert();
	const pushToast = useWorkspaceToast();
	const [isPending, setIsPending] = useState(false);

	const handleClick = useCallback(async () => {
		if (disabled || isPending) return;

		setIsPending(true);
		try {
			const payload = await getPayload();
			if (!payload) return;
			insertIntoComposer(normalizeAppendContextPayload(payload));
			onInserted?.();
		} catch (error) {
			pushToast(
				error instanceof Error ? error.message : "Unable to append context.",
				errorTitle,
				"destructive",
			);
		} finally {
			setIsPending(false);
		}
	}, [
		disabled,
		errorTitle,
		getPayload,
		insertIntoComposer,
		isPending,
		onInserted,
		pushToast,
	]);

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={ariaLabel ?? `Append ${subjectLabel} to composer`}
			disabled={disabled || isPending}
			onClick={(event) => {
				event.stopPropagation();
				void handleClick();
			}}
			onKeyDown={(event) => event.stopPropagation()}
			className={cn(
				"size-4 rounded-sm transition-colors disabled:pointer-events-none disabled:opacity-60",
				className,
			)}
		>
			{isPending ? (
				<LoaderCircle className="size-3 animate-spin" strokeWidth={1.8} />
			) : (
				<LayersPlus className="size-3" strokeWidth={1.8} />
			)}
		</Button>
	);
}
