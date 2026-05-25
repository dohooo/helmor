// Repo-level scripts section (setup / run-scripts / archive). All three
// follow the same `ScriptField` rhythm: a left-aligned label + tooltip
// description above the editor, with optional right-side controls in the
// header slot. The Run section is a list of editable rows (DB-owned) or
// read-only rows mirroring helmor.json. The "Add script" button lives in
// the section header's right slot so the list itself stays a clean
// vertical stack of name+command pairs aligned with setup/archive.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	HelpCircle,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	createRepoRunAction,
	deleteRepoRunAction,
	loadRepoScripts,
	type RunAction,
	type RunScriptMode,
	updateRepoAutoRunSetup,
	updateRepoRunAction,
	updateRepoScripts,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export function ScriptsSection({
	repoId,
	workspaceId,
}: {
	repoId: string;
	workspaceId: string | null;
}) {
	const queryClient = useQueryClient();
	const scriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId, workspaceId],
		queryFn: () => loadRepoScripts(repoId, workspaceId),
		staleTime: 0,
	});

	const data = scriptsQuery.data;
	const setupLocked = data?.setupFromProject ?? false;
	const runLocked = data?.runFromProject ?? false;
	const archiveLocked = data?.archiveFromProject ?? false;
	const runActions = data?.runActions ?? [];

	const [setupScript, setSetupScript] = useState("");
	const [archiveScript, setArchiveScript] = useState("");
	const [autoRunSetup, setAutoRunSetup] = useState(false);
	const initialized = useRef(false);

	// Id of the row that should grab focus on mount. Cleared after focus
	// fires so subsequent re-renders (e.g. query refetch) don't keep
	// stealing the user's caret.
	const [focusActionId, setFocusActionId] = useState<string | null>(null);

	useEffect(() => {
		if (!data) return;
		const shouldSyncSetup = setupLocked || !initialized.current;
		const shouldSyncArchive = archiveLocked || !initialized.current;
		if (shouldSyncSetup) setSetupScript(data.setupScript ?? "");
		if (shouldSyncArchive) setArchiveScript(data.archiveScript ?? "");
		if (!initialized.current) {
			setAutoRunSetup(data.autoRunSetup);
		}
		if (!setupLocked && !archiveLocked) {
			initialized.current = true;
		}
	}, [data, setupLocked, archiveLocked]);

	// Reset when switching repos.
	useEffect(() => {
		initialized.current = false;
	}, [repoId]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const save = useCallback(
		(nextSetup: string, nextArchive: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepoScripts(
					repoId,
					nextSetup.trim() || null,
					nextArchive.trim() || null,
				).then(() => {
					void queryClient.invalidateQueries({
						queryKey: ["repoScripts", repoId],
					});
				});
			}, 600);
		},
		[repoId, queryClient],
	);

	const handleSetupChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setSetupScript(value);
			save(value, archiveScript);
		},
		[archiveScript, save],
	);

	const handleArchiveChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setArchiveScript(value);
			save(setupScript, value);
		},
		[setupScript, save],
	);

	const handleAutoRunSetupChange = useCallback(
		(checked: boolean) => {
			setAutoRunSetup(checked);
			void updateRepoAutoRunSetup(repoId, checked).then(() => {
				void queryClient.invalidateQueries({
					queryKey: ["repoScripts", repoId],
				});
			});
		},
		[repoId, queryClient],
	);

	const handleCreateRunAction = useCallback(async () => {
		// First row gets "Default" (matches the legacy / single-script
		// convention). Subsequent rows are "Script N" so they're clearly
		// distinct and the user is nudged to rename them.
		const fallbackName =
			runActions.length === 0 ? "Default" : `Script ${runActions.length + 1}`;
		const created = await createRepoRunAction(
			repoId,
			fallbackName,
			"",
			"concurrent",
		);
		setFocusActionId(created.id);
		void queryClient.invalidateQueries({
			queryKey: ["repoScripts", repoId],
		});
	}, [repoId, queryClient, runActions.length]);

	const setupHasScript = !!setupScript.trim();

	return (
		<div className="py-5">
			<div className="text-ui font-medium leading-snug text-foreground">
				Scripts
			</div>
			<div className="mt-1 text-small leading-snug text-muted-foreground">
				Commands that run when workspaces are set up, run, or archived.
			</div>

			<div className="mt-4 space-y-4">
				<ScriptField
					label="Setup script"
					description="Available from the Setup tab in any workspace"
					placeholder="e.g., npm install"
					value={setupScript}
					locked={setupLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleSetupChange}
					headerRight={
						<div className="flex items-center gap-1.5">
							<span className="text-mini font-medium text-muted-foreground">
								Auto-run
							</span>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<HelpCircle
											className="size-3 cursor-help text-muted-foreground/70"
											strokeWidth={1.8}
										/>
									</TooltipTrigger>
									<TooltipContent side="top" className="max-w-[240px]">
										On by default — setup runs automatically as soon as a
										workspace is created. Turn off to run it manually from the
										Setup tab.
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<Switch
								checked={autoRunSetup}
								onCheckedChange={handleAutoRunSetupChange}
								disabled={!setupHasScript}
								aria-label="Auto-run setup script on workspace creation"
							/>
						</div>
					}
				/>

				<RunScriptsSection
					repoId={repoId}
					actions={runActions}
					locked={runLocked}
					focusActionId={focusActionId}
					onFocused={() => setFocusActionId(null)}
					onCreate={() => void handleCreateRunAction()}
				/>

				<ScriptField
					label="Archive script"
					description="Runs when a workspace is archived"
					placeholder="e.g., docker compose down"
					value={archiveScript}
					locked={archiveLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleArchiveChange}
				/>
			</div>
		</div>
	);
}

function ScriptField({
	label,
	description,
	placeholder,
	value,
	locked,
	lockedMessage,
	onChange,
	headerRight,
}: {
	label: string;
	description: string;
	placeholder: string;
	value: string;
	locked: boolean;
	lockedMessage: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	headerRight?: React.ReactNode;
}) {
	const textarea = (
		<Textarea
			className="mt-2 min-h-[72px] resize-y bg-app-base/30 font-mono text-small"
			placeholder={placeholder}
			value={value}
			onChange={onChange}
			readOnly={locked}
			disabled={locked}
		/>
	);

	return (
		<div>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-small font-medium text-app-foreground">
						{label}
					</div>
					<div className="mt-0.5 text-mini text-muted-foreground">
						{description}
					</div>
				</div>
				{headerRight && <div className="shrink-0">{headerRight}</div>}
			</div>
			{locked ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{textarea}</TooltipTrigger>
						<TooltipContent side="top">{lockedMessage}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				textarea
			)}
		</div>
	);
}

/**
 * Run-scripts section. One section header plus a vertical stack of
 * collapsible cards — each card is one run action. Collapsed cards show
 * just the name, the first line of the command, and the Exclusive
 * toggle; expanding reveals the full editor (name + command + optional
 * Stop command / Timeout) along with the Edit (pencil) + Delete
 * buttons. This mirrors the {@link RepositoryPreferencesSection}'s
 * accordion pattern so the Settings tab reads as a consistent stack of
 * progressive-disclosure sections.
 */
function RunScriptsSection({
	repoId,
	actions,
	locked,
	focusActionId,
	onFocused,
	onCreate,
}: {
	repoId: string;
	actions: RunAction[];
	locked: boolean;
	focusActionId: string | null;
	onFocused: () => void;
	onCreate: () => void;
}) {
	return (
		<div>
			<div className="min-w-0">
				<div className="text-small font-medium text-app-foreground">
					Run scripts
				</div>
				<div className="mt-0.5 text-mini text-muted-foreground">
					Each entry appears in the Inspector's Run dropdown.
				</div>
			</div>

			{actions.length === 0 ? (
				locked ? (
					<div className="mt-2 text-mini text-muted-foreground/70">
						Set by this workspace's helmor.json — edit it there.
					</div>
				) : (
					// Empty state: dashed placeholder explaining what run
					// scripts are for. The dashed border + muted bg
					// signals "nothing here yet"; the `Add script` CTA
					// sits below so the user always finds the entry point.
					<div className="mt-3 rounded-lg border border-dashed border-border/60 bg-app-base/30 px-4 py-5 text-center">
						<div className="text-small font-medium text-foreground">
							No run scripts yet
						</div>
						<div className="mx-auto mt-1 max-w-[320px] text-mini leading-relaxed text-muted-foreground">
							Add one to expose a command — like a dev server, test runner, or
							background task.
						</div>
					</div>
				)
			) : (
				<div className="mt-3 space-y-2">
					{actions.map((action) => (
						<RunScriptRow
							key={action.id}
							repoId={repoId}
							action={action}
							locked={locked}
							autoFocus={focusActionId === action.id}
							onFocused={onFocused}
						/>
					))}
				</div>
			)}

			{/* Add CTA on its own line below the list so it can't be
			    misread as a control on the section above. Kept compact
			    (`size="xs"`) so it reads as a focused entry point, not a
			    primary action that competes with the editors. */}
			{!locked && (
				<div className="mt-3">
					<Button
						variant="default"
						size="xs"
						className="gap-1 hover:bg-primary/80"
						onClick={onCreate}
					>
						<Plus strokeWidth={2} />
						Add script
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * One row in the Run scripts list — a collapsible card whose collapsed
 * header shows just the essentials (name + first-line of the command +
 * Exclusive toggle) and whose expanded body reveals the full editor.
 * Edit mode is gated behind a pencil button so accidental clicks on a
 * row don't put the user into an editable state.
 *
 * Read-only (`isProjectOwned`) actions reuse the same collapsible
 * skeleton but with the Exclusive switch disabled, no Edit / Delete
 * buttons, and inputs that never become editable.
 */
function RunScriptRow({
	repoId,
	action,
	locked,
	autoFocus,
	onFocused,
}: {
	repoId: string;
	action: RunAction;
	locked: boolean;
	autoFocus: boolean;
	onFocused: () => void;
}) {
	const queryClient = useQueryClient();
	const isProjectOwned = action.fromProject || locked;

	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);

	const [name, setName] = useState(action.name);
	const [command, setCommand] = useState(action.command);
	const [mode, setMode] = useState<RunScriptMode>(action.mode);
	const [stopCommand, setStopCommand] = useState(action.stopCommand ?? "");
	// Inline 2-click delete: first click flips this to `true` and the
	// trash icon swaps to a check; second click actually deletes. Auto-
	// resets after `DELETE_CONFIRM_RESET_MS` of inactivity so an
	// abandoned confirm doesn't quietly stay armed.
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const deleteResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	// Keep local state in sync when the upstream record changes (e.g. an
	// out-of-band update via UI-sync). We only overwrite the local draft
	// when the incoming value diverges — guards against clobbering the
	// caret while the user is mid-typing.
	const lastSyncedRef = useRef({
		name: action.name,
		command: action.command,
		mode: action.mode,
		stopCommand: action.stopCommand ?? "",
	});
	useEffect(() => {
		const prev = lastSyncedRef.current;
		const nextStopCommand = action.stopCommand ?? "";
		if (prev.name !== action.name) setName(action.name);
		if (prev.command !== action.command) setCommand(action.command);
		if (prev.mode !== action.mode) setMode(action.mode);
		if (prev.stopCommand !== nextStopCommand) setStopCommand(nextStopCommand);
		lastSyncedRef.current = {
			name: action.name,
			command: action.command,
			mode: action.mode,
			stopCommand: nextStopCommand,
		};
	}, [action.name, action.command, action.mode, action.stopCommand]);

	const nameInputRef = useRef<HTMLInputElement | null>(null);

	// Fresh-row affordance: when the parent flags this row as the one
	// that should grab focus (e.g. the user just clicked "Add script"),
	// open the card, switch to edit mode, and focus the name input.
	useEffect(() => {
		if (!autoFocus || isProjectOwned) return;
		setOpen(true);
		setEditing(true);
		// Defer focus until the collapsible has rendered its content.
		const id = window.setTimeout(() => {
			nameInputRef.current?.focus();
			nameInputRef.current?.select();
			onFocused();
		}, 0);
		return () => window.clearTimeout(id);
	}, [autoFocus, isProjectOwned, onFocused]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const persist = useCallback(
		(next: {
			name: string;
			command: string;
			mode: RunScriptMode;
			stopCommand: string;
		}) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				const trimmedName = next.name.trim();
				// Drop empty-name writes — backend rejects them and we'd
				// just bounce. The red-ring affordance below tells the
				// user why nothing's persisting.
				if (!trimmedName) return;
				// Build the stop command: empty / whitespace → null.
				const trimmedStopCommand = next.stopCommand.trim();
				void updateRepoRunAction(
					repoId,
					action.id,
					trimmedName,
					next.command,
					next.mode,
					trimmedStopCommand || null,
				).then(() => {
					void queryClient.invalidateQueries({
						queryKey: ["repoScripts", repoId],
					});
				});
			}, 600);
		},
		[repoId, action.id, queryClient],
	);

	// Flush pending edits if the row unmounts (e.g. deleted, navigated
	// away). 600ms is forgiving but a fast close-the-dialog could drop
	// the last keystroke otherwise.
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, []);

	const handleDelete = useCallback(async () => {
		setDeleting(true);
		try {
			await deleteRepoRunAction(repoId, action.id);
			// UI-sync will invalidate, but invalidate explicitly so the
			// row disappears immediately even if the event is in flight.
			void queryClient.invalidateQueries({
				queryKey: ["repoScripts", repoId],
			});
		} finally {
			setDeleting(false);
			setConfirmingDelete(false);
		}
	}, [repoId, action.id, queryClient]);

	// Auto-reset the armed-delete state after a short window of
	// inactivity. 3s is enough for a deliberate second click but short
	// enough that an abandoned confirm doesn't sit armed indefinitely.
	const DELETE_CONFIRM_RESET_MS = 3000;
	useEffect(() => {
		if (!confirmingDelete) return;
		if (deleteResetTimerRef.current) {
			clearTimeout(deleteResetTimerRef.current);
		}
		deleteResetTimerRef.current = setTimeout(() => {
			setConfirmingDelete(false);
		}, DELETE_CONFIRM_RESET_MS);
		return () => {
			if (deleteResetTimerRef.current) {
				clearTimeout(deleteResetTimerRef.current);
				deleteResetTimerRef.current = null;
			}
		};
	}, [confirmingDelete]);

	const handleDeleteClick = useCallback(() => {
		if (deleting) return;
		if (!confirmingDelete) {
			setConfirmingDelete(true);
			return;
		}
		void handleDelete();
	}, [confirmingDelete, deleting, handleDelete]);

	const nameInvalid = !name.trim();
	// First line of the command, truncated by CSS to a single row in the
	// collapsed header. Empty fallback so new rows still render
	// something usable in the chip.
	const firstCommandLine =
		command.split("\n").find((line) => line.trim().length > 0) ?? "";
	// Show the Stop command row only when editing or when it carries a
	// value — view-mode stays clean for the 99% of actions that don't
	// configure one.
	const showStopRow = editing || stopCommand.trim().length > 0;

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		// Collapsing the card always exits edit mode and clears any armed
		// delete — otherwise reopening would unexpectedly show editable
		// inputs or fire a delete on the first click.
		if (!next) {
			setEditing(false);
			setConfirmingDelete(false);
		}
	};

	return (
		<Collapsible
			open={open}
			onOpenChange={handleOpenChange}
			className="rounded-lg border border-app-border/40 bg-app-base/20"
		>
			{/* Header: stays clickable even with the Exclusive switch on
				    the right by splitting trigger and controls. */}
			<div className="flex items-center gap-2 px-3 py-2">
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex min-w-0 flex-1 cursor-interactive items-center gap-2 text-left"
						aria-label={`${open ? "Collapse" : "Expand"} ${action.name || "script"}`}
					>
						<ChevronDown
							className={cn(
								"size-3.5 shrink-0 text-app-muted transition-transform",
								open && "rotate-180",
							)}
							strokeWidth={1.8}
						/>
						<span
							className={cn(
								"text-small font-medium",
								name.trim()
									? "text-foreground"
									: "text-muted-foreground italic",
							)}
						>
							{name.trim() || "(unnamed)"}
						</span>
						<span className="min-w-0 flex-1 truncate text-mini font-mono text-muted-foreground">
							{firstCommandLine || "(no command)"}
						</span>
					</button>
				</CollapsibleTrigger>
				<div className="flex shrink-0 items-center gap-1.5">
					<span className="text-mini font-medium text-muted-foreground">
						Exclusive
					</span>
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<HelpCircle
									className="size-3 cursor-help text-muted-foreground/70"
									strokeWidth={1.8}
								/>
							</TooltipTrigger>
							<TooltipContent side="top" className="max-w-[240px]">
								Only let one workspace run this script at a time. Starting a new
								run stops any other run in this repository — useful when the
								script binds a fixed port.
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
					<Switch
						checked={mode === "non-concurrent"}
						disabled={isProjectOwned}
						onCheckedChange={(checked) => {
							if (isProjectOwned) return;
							const next: RunScriptMode = checked
								? "non-concurrent"
								: "concurrent";
							setMode(next);
							persist({
								name,
								command,
								mode: next,
								stopCommand,
							});
						}}
						aria-label="Stop other runs in this repository when starting a new run"
					/>
				</div>
			</div>

			<CollapsibleContent>
				<div className="border-t border-app-border/30 px-3 pt-3 pb-1.5">
					{/* Script name */}
					<div className="text-mini font-medium text-muted-foreground">
						Script name
					</div>
					{editing ? (
						<Input
							ref={nameInputRef}
							className="mt-1 h-7 text-small font-medium"
							placeholder="Script name"
							value={name}
							aria-invalid={nameInvalid}
							aria-label="Script name"
							onChange={(e) => {
								const value = e.target.value;
								setName(value);
								persist({
									name: value,
									command,
									mode,
									stopCommand,
								});
							}}
						/>
					) : (
						<div className="mt-1 text-small font-medium text-foreground">
							{name.trim() || (
								<span className="text-muted-foreground italic">(unnamed)</span>
							)}
						</div>
					)}

					{/* Command */}
					<div className="mt-3 text-mini font-medium text-muted-foreground">
						Command
					</div>
					{editing ? (
						<Textarea
							className="mt-1 min-h-[56px] resize-y bg-app-base/30 font-mono text-small"
							placeholder="e.g., npm run dev"
							value={command}
							aria-label={`${action.name || "Script"} command`}
							onChange={(e) => {
								const value = e.target.value;
								setCommand(value);
								persist({
									name,
									command: value,
									mode,
									stopCommand,
								});
							}}
						/>
					) : (
						<pre className="mt-1 whitespace-pre-wrap break-all font-mono text-small text-foreground">
							{command || (
								<span className="text-muted-foreground italic">(empty)</span>
							)}
						</pre>
					)}

					{/* Stop command — only rendered when set OR while
						    editing. Reuses Command's Textarea styling so the
						    two read as a pair. */}
					{showStopRow ? (
						<>
							<div className="mt-3 flex items-center gap-1 text-mini font-medium text-muted-foreground">
								Stop command
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<HelpCircle
												className="size-3 cursor-help text-muted-foreground/70"
												strokeWidth={1.8}
											/>
										</TooltipTrigger>
										<TooltipContent side="top" className="max-w-[280px]">
											Optional cleanup command run when you click Stop. Useful
											for scripts that manage external resources (docker compose
											down, supabase stop). Same env + cwd as the main command.
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>
							{editing ? (
								<Textarea
									className="mt-1 min-h-[56px] resize-y bg-app-base/30 font-mono text-small"
									placeholder="e.g., docker compose down"
									value={stopCommand}
									aria-label={`${action.name || "Script"} stop command`}
									onChange={(e) => {
										const value = e.target.value;
										setStopCommand(value);
										persist({
											name,
											command,
											mode,
											stopCommand: value,
										});
									}}
								/>
							) : (
								<pre className="mt-1 whitespace-pre-wrap break-all font-mono text-small text-foreground">
									{stopCommand || (
										<span className="text-muted-foreground italic">
											(empty)
										</span>
									)}
								</pre>
							)}
						</>
					) : null}

					{/* Bottom-right toolbar: Edit (pencil) + Delete. Gated
						    to the expanded state so a misclick on a collapsed
						    row can't trash anything. For project-owned actions
						    we swap the buttons out for a small "Managed by
						    helmor.json" hint in the same slot (same align,
						    same vertical rhythm) so the user knows why the
						    controls aren't there. */}
					{!isProjectOwned ? (
						<div className="mt-2 flex items-center justify-end gap-1">
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={editing ? "secondary" : "ghost"}
											size="icon"
											className={cn(
												"size-7",
												editing
													? "text-primary"
													: "text-muted-foreground hover:text-foreground",
											)}
											onClick={() => setEditing((prev) => !prev)}
											aria-pressed={editing}
											aria-label={editing ? "Stop editing" : "Edit"}
										>
											{editing ? (
												<Check className="size-3.5" strokeWidth={2} />
											) : (
												<Pencil className="size-3.5" strokeWidth={1.8} />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{editing ? "Done editing" : "Edit"}
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant={confirmingDelete ? "destructive" : "ghost"}
											size="icon"
											className={cn(
												"size-7",
												!confirmingDelete &&
													"text-muted-foreground hover:text-destructive",
											)}
											onClick={handleDeleteClick}
											disabled={deleting}
											aria-label={
												confirmingDelete
													? `Confirm delete ${action.name || "(unnamed)"}`
													: `Delete script ${action.name || "(unnamed)"}`
											}
										>
											{confirmingDelete ? (
												<Check className="size-3.5" strokeWidth={2} />
											) : (
												<Trash2 className="size-3.5" strokeWidth={1.8} />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{confirmingDelete
											? "Click again to confirm"
											: "Delete script"}
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
					) : (
						<div className="mt-2 flex h-7 items-center justify-end text-mini text-muted-foreground/70">
							Managed by helmor.json — edit the file to add or change
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
