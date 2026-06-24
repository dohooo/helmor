// Header strip for the workspace conversation pane: editor picker on the
// left and inspector toggle on the right. Extracted out of App.tsx
// to keep the shell render path focused on layout.
import {
	Check,
	ChevronDown,
	FolderOpen,
	MoreHorizontal,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	type DetectedEditor,
	openWorkspaceInEditor,
	openWorkspaceInFinder,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { EditorIcon } from "@/shell/editor-icon";
import { PREFERRED_EDITOR_STORAGE_KEY } from "@/shell/layout";

type Props = {
	workspaceId: string;
	installedEditors: DetectedEditor[];
	preferredEditor: DetectedEditor | null;
	openPreferredEditorShortcut: string | null;
	rightSidebarToggleShortcut: string | null;
	inspectorCollapsed: boolean;
	/** No-git workspaces (chat + non-git) hide the editor/finder picker
	 *  and the inspector toggle (the inspector pane is hidden entirely). */
	noGitContext?: boolean;
	onOpenPreferredEditor: () => void;
	onToggleInspector: () => void;
	onPickEditor: (editorId: string) => void;
	pushWorkspaceToast: PushWorkspaceToast;
};

export function WorkspaceHeaderActions({
	workspaceId,
	installedEditors,
	preferredEditor,
	openPreferredEditorShortcut,
	rightSidebarToggleShortcut,
	inspectorCollapsed,
	noGitContext = false,
	onOpenPreferredEditor,
	onToggleInspector,
	onPickEditor,
	pushWorkspaceToast,
}: Props) {
	const { t, f } = useI18n();
	const hasEditorActions =
		!noGitContext && installedEditors.length > 0 && preferredEditor !== null;

	return (
		<div className="flex items-center gap-1">
			{hasEditorActions ? (
				<div className="flex -translate-x-[9px] items-center gap-0 max-[960px]:-translate-x-[1px] max-[640px]:hidden">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="xs"
								aria-label={f("miscOpenInEditor", {
									editor: preferredEditor.name,
								})}
								onClick={onOpenPreferredEditor}
								className="px-0.5 text-muted-foreground hover:text-foreground"
							>
								<EditorIcon
									editorId={preferredEditor.id}
									className="size-3.5"
								/>
								<span>{preferredEditor.name}</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							sideOffset={4}
							className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
						>
							<span>
								{f("miscOpenInEditor", { editor: preferredEditor.name })}
							</span>
							{openPreferredEditorShortcut ? (
								<InlineShortcutDisplay
									hotkey={openPreferredEditorShortcut}
									className="text-background/60"
								/>
							) : null}
						</TooltipContent>
					</Tooltip>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="xs"
								className="h-6 px-0.5 text-muted-foreground hover:text-foreground"
							>
								<ChevronDown className="size-2.5" strokeWidth={2} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							side="bottom"
							align="end"
							sideOffset={4}
							className="min-w-[11rem]"
						>
							<DropdownMenuItem
								onClick={() => {
									void openWorkspaceInFinder(workspaceId).catch((e) =>
										pushWorkspaceToast(String(e), t("miscFailedToOpenFinder")),
									);
								}}
							>
								<FolderOpen className="shrink-0" strokeWidth={1.8} />
								<span className="flex-1">{t("finder")}</span>
							</DropdownMenuItem>
							{installedEditors.map((editor) => (
								<DropdownMenuItem
									key={editor.id}
									onClick={() => {
										onPickEditor(editor.id);
										localStorage.setItem(
											PREFERRED_EDITOR_STORAGE_KEY,
											editor.id,
										);
										void openWorkspaceInEditor(workspaceId, editor.id).catch(
											(e) =>
												pushWorkspaceToast(
													String(e),
													f("failedOpenEditor", { editor: editor.name }),
												),
										);
									}}
								>
									<EditorIcon editorId={editor.id} className="shrink-0" />
									<span className="flex-1">{editor.name}</span>
									{editor.id === preferredEditor.id && (
										<Check className="ml-auto text-muted-foreground" />
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			) : null}
			<div className="flex -translate-x-px items-center gap-1">
				{hasEditorActions ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								aria-label="moreWorkspaceActions"
								variant="ghost"
								size="icon-xs"
								className="hidden text-muted-foreground hover:text-foreground max-[640px]:inline-flex"
							>
								<MoreHorizontal className="size-4" strokeWidth={1.8} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							side="bottom"
							align="end"
							sideOffset={4}
							className="min-w-[11rem]"
						>
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<EditorIcon
										editorId={preferredEditor.id}
										className="shrink-0"
									/>
									<span className="flex-1">{t("open")}</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="min-w-[11rem]">
									<DropdownMenuItem
										onClick={() => {
											void openWorkspaceInFinder(workspaceId).catch((e) =>
												pushWorkspaceToast(
													String(e),
													t("miscFailedToOpenFinder"),
												),
											);
										}}
									>
										<FolderOpen className="shrink-0" strokeWidth={1.8} />
										<span className="flex-1">{t("finder")}</span>
									</DropdownMenuItem>
									{installedEditors.map((editor) => (
										<DropdownMenuItem
											key={editor.id}
											onClick={() => {
												onPickEditor(editor.id);
												localStorage.setItem(
													PREFERRED_EDITOR_STORAGE_KEY,
													editor.id,
												);
												void openWorkspaceInEditor(
													workspaceId,
													editor.id,
												).catch((e) =>
													pushWorkspaceToast(
														String(e),
														f("failedOpenEditor", { editor: editor.name }),
													),
												);
											}}
										>
											<EditorIcon editorId={editor.id} className="shrink-0" />
											<span className="flex-1">{editor.name}</span>
											{editor.id === preferredEditor.id && (
												<Check className="ml-auto text-muted-foreground" />
											)}
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				{/* Inspector toggle hidden for no-git workspaces — the inspector
				 *  pane itself is hidden, so the button has nothing to toggle. */}
				{!noGitContext ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								aria-label={
									inspectorCollapsed
										? "miscExpandRightSidebar"
										: "miscCollapseRightSidebar"
								}
								onClick={onToggleInspector}
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground hover:text-foreground max-[960px]:hidden"
							>
								{inspectorCollapsed ? (
									<PanelRightOpen className="size-4" strokeWidth={1.8} />
								) : (
									<PanelRightClose className="size-4" strokeWidth={1.8} />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
						>
							<span>
								{inspectorCollapsed
									? t("miscExpandRightSidebar")
									: t("miscCollapseRightSidebar")}
							</span>
							{rightSidebarToggleShortcut ? (
								<InlineShortcutDisplay
									hotkey={rightSidebarToggleShortcut}
									className="text-background/60"
								/>
							) : null}
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>
		</div>
	);
}
