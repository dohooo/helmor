import { CircleAlert, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { normalizeShortcutEvent } from "./format";
import {
	beginShortcutRecording,
	endShortcutRecording,
} from "./recording-state";
import {
	findShortcutConflict,
	getShortcut,
	getShortcutConflicts,
	SHORTCUT_DEFINITIONS,
	updateShortcutOverride,
} from "./registry";
import { InlineShortcutDisplay } from "./shortcut-display";
import type { ShortcutDefinition, ShortcutGroup, ShortcutId } from "./types";

const GROUPS: ShortcutGroup[] = [
	"Navigation",
	"Session",
	"Workspace",
	"Actions",
	"System",
	"Composer",
	"Terminal",
];
const PINNED_SHORTCUT_IDS: ShortcutId[] = ["global.hotkey"];
const PINNED_SHORTCUT_ID_SET = new Set<ShortcutId>(PINNED_SHORTCUT_IDS);

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
const FUNCTION_KEYS = new Set([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"End",
	"Home",
	"Insert",
	"PageDown",
	"PageUp",
	"Tab",
]);

function canRecordShortcut(event: KeyboardEvent) {
	if (event.altKey || event.ctrlKey || event.metaKey) return true;
	if (/^F\d{1,2}$/.test(event.key)) return true;
	return FUNCTION_KEYS.has(event.key);
}

type ShortcutsSettingsPanelProps = {
	overrides: Partial<Record<ShortcutId, string | null>>;
	onChange: (overrides: Partial<Record<ShortcutId, string | null>>) => void;
};

export function ShortcutsSettingsPanel({
	overrides,
	onChange,
}: ShortcutsSettingsPanelProps) {
	const [query, setQuery] = useState("");
	const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
	const [shakeId, setShakeId] = useState<ShortcutId | null>(null);
	const normalizedQuery = query.trim().toLowerCase();
	const conflicts = useMemo(() => getShortcutConflicts(overrides), [overrides]);
	const filteredDefinitions = useMemo(
		() =>
			SHORTCUT_DEFINITIONS.filter((definition) => {
				if (!normalizedQuery) return true;
				const hotkey = getShortcut(overrides, definition.id) ?? "";
				return `${definition.title} ${definition.description ?? ""} ${definition.group} ${hotkey}`
					.toLowerCase()
					.includes(normalizedQuery);
			}),
		[normalizedQuery, overrides],
	);
	const pinnedDefinitions = useMemo(
		() =>
			SHORTCUT_DEFINITIONS.filter((definition) =>
				PINNED_SHORTCUT_ID_SET.has(definition.id),
			),
		[],
	);
	const regularDefinitions = useMemo(
		() =>
			filteredDefinitions.filter(
				(definition) => !PINNED_SHORTCUT_ID_SET.has(definition.id),
			),
		[filteredDefinitions],
	);
	const triggerConflictShake = (id: ShortcutId) => {
		setShakeId(id);
		window.setTimeout(() => {
			setShakeId((current) => (current === id ? null : current));
		}, 260);
	};
	const renderShortcutRow = (
		definition: ShortcutDefinition,
		isLastInGroup: boolean,
	) => (
		<ShortcutRow
			key={definition.id}
			definition={definition}
			hotkey={getShortcut(overrides, definition.id)}
			conflicts={conflicts.conflictById[definition.id] ?? []}
			isRecording={recordingId === definition.id}
			shake={shakeId === definition.id}
			overrides={overrides}
			onChange={onChange}
			onConflictRecorded={() => triggerConflictShake(definition.id)}
			onRecordingChange={(recording) =>
				setRecordingId(recording ? definition.id : null)
			}
			isLastInGroup={isLastInGroup}
		/>
	);

	return (
		<TooltipProvider delayDuration={150}>
			<div className="py-5">
				<div className="relative">
					<Search
						className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
						strokeWidth={1.8}
					/>
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search shortcuts"
						className="h-9 rounded-lg border-border/50 bg-muted/20 pl-8 text-[13px]"
					/>
				</div>
			</div>

			<section className="pb-1">
				<div className="pb-1 text-[12px] font-medium tracking-normal text-muted-foreground">
					Global
				</div>
				{pinnedDefinitions.map((definition, index) =>
					renderShortcutRow(definition, index === pinnedDefinitions.length - 1),
				)}
			</section>

			{GROUPS.map((group) => {
				const definitions = regularDefinitions.filter(
					(definition) => definition.group === group,
				);
				if (definitions.length === 0) return null;

				return (
					<section key={group} className="pt-3 pb-1">
						<div className="pb-1 text-[12px] font-medium tracking-normal text-muted-foreground">
							{group}
						</div>
						{definitions.map((definition, index) =>
							renderShortcutRow(definition, index === definitions.length - 1),
						)}
					</section>
				);
			})}
		</TooltipProvider>
	);
}

type ShortcutRowProps = {
	definition: ShortcutDefinition;
	hotkey: string | null;
	conflicts: ShortcutDefinition[];
	isRecording: boolean;
	shake: boolean;
	overrides: Partial<Record<ShortcutId, string | null>>;
	onChange: (overrides: Partial<Record<ShortcutId, string | null>>) => void;
	onConflictRecorded: () => void;
	onRecordingChange: (recording: boolean) => void;
	isLastInGroup: boolean;
};

function ShortcutRow({
	definition,
	hotkey,
	conflicts,
	isRecording,
	shake,
	overrides,
	onChange,
	onConflictRecorded,
	onRecordingChange,
	isLastInGroup,
}: ShortcutRowProps) {
	const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
	const hasConflict = conflicts.length > 0;
	const isCustomized = Object.hasOwn(overrides, definition.id);
	const [menuOpen, setMenuOpen] = useState(false);
	const handleReset = () => {
		onChange(
			updateShortcutOverride(
				overrides,
				definition.id,
				definition.defaultHotkey,
			),
		);
	};

	useEffect(() => {
		if (!isRecording) return;
		beginShortcutRecording();

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onRecordingChange(false);
				return;
			}

			if (MODIFIER_KEYS.has(event.key)) return;

			const hasModifier =
				event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
			if (
				!hasModifier &&
				(event.key === "Backspace" || event.key === "Delete")
			) {
				event.preventDefault();
				event.stopPropagation();
				onChange(updateShortcutOverride(overrides, definition.id, null));
				onRecordingChange(false);
				return;
			}

			const nextHotkey = normalizeShortcutEvent(event);
			if (!nextHotkey) return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			if (!canRecordShortcut(event)) return;

			const nextConflict = findShortcutConflict(
				overrides,
				definition.id,
				nextHotkey,
			);
			onChange(updateShortcutOverride(overrides, definition.id, nextHotkey));
			if (nextConflict) {
				onConflictRecorded();
			}
			onRecordingChange(false);
		};

		const handlePointerDown = (event: PointerEvent) => {
			if (shortcutButtonRef.current?.contains(event.target as Node)) return;
			onRecordingChange(false);
		};

		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => {
			endShortcutRecording();
			document.removeEventListener("keydown", handleKeyDown, true);
			document.removeEventListener("pointerdown", handlePointerDown, true);
		};
	}, [
		definition.id,
		isRecording,
		onChange,
		onConflictRecorded,
		onRecordingChange,
		overrides,
	]);

	return (
		<div className={cn("py-1", !isLastInGroup && "border-b border-border/40")}>
			<ContextMenu onOpenChange={setMenuOpen}>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"group flex items-center justify-between gap-3 rounded-xl px-2 py-2 transition-[background-color,box-shadow]",
							hasConflict
								? "bg-destructive/10"
								: isRecording
									? "bg-primary/[0.06]"
									: undefined,
							menuOpen && "ring-1 ring-border",
						)}
						onContextMenu={(event) => {
							if (isRecording) {
								event.preventDefault();
							}
						}}
					>
						<div className="min-w-0">
							<div className="truncate text-[13px] font-medium leading-snug text-foreground">
								{definition.title}
							</div>
							{definition.description ? (
								<div className="mt-1 text-[11px] text-muted-foreground">
									{definition.description}
								</div>
							) : null}
						</div>

						<div className="flex shrink-0 items-center gap-2">
							{hasConflict ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label="Shortcut conflict"
											className="cursor-default text-destructive"
										>
											<CircleAlert className="size-4" strokeWidth={2.2} />
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										className="max-w-xs whitespace-normal text-[11px] leading-snug"
									>
										Already used by{" "}
										{conflicts
											.map((conflict) => `"${conflict.title}"`)
											.join(", ")}
									</TooltipContent>
								</Tooltip>
							) : null}
							{isCustomized ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label="Reset to default"
											className="inline-flex size-[18px] cursor-interactive items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
											onClick={handleReset}
										>
											<RotateCcw className="size-[11px]" strokeWidth={2} />
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										className="text-[11px] leading-snug"
									>
										Reset to default
									</TooltipContent>
								</Tooltip>
							) : null}
							<button
								ref={shortcutButtonRef}
								type="button"
								className={cn(
									"inline-flex h-8 min-w-[3.75rem] shrink-0 cursor-interactive items-center justify-center rounded-lg border border-border/55 bg-background px-2 text-[12.5px] font-medium text-muted-foreground shadow-sm outline-none transition-[border-color,box-shadow,color,background-color] hover:border-primary/60 hover:bg-background focus:outline-none focus-visible:outline-none focus-visible:ring-0",
									isRecording &&
										"shortcut-recording-pulse relative overflow-visible border-primary bg-background text-primary shadow-none hover:border-primary hover:bg-background hover:text-primary",
									shake && "shortcut-conflict-shake",
								)}
								onClick={() => {
									onRecordingChange(true);
								}}
							>
								{hotkey ? (
									<InlineShortcutDisplay
										hotkey={hotkey}
										className="text-current"
									/>
								) : (
									<span className="text-[13px] tracking-[0.08em] text-muted-foreground">
										---
									</span>
								)}
							</button>
						</div>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="min-w-[11.5rem]">
					<ContextMenuItem
						className="px-2"
						onSelect={() =>
							onChange(updateShortcutOverride(overrides, definition.id, null))
						}
					>
						Remove Shortcut
					</ContextMenuItem>
					<ContextMenuItem className="px-2" onSelect={handleReset}>
						Reset Shortcut to Default
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		</div>
	);
}
