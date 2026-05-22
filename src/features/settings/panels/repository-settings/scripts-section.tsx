// Repo-level scripts section (setup / run-scripts / archive). All three
// follow the same `ScriptField` rhythm: a left-aligned label + tooltip
// description above the editor, with optional right-side controls in the
// header slot. The Run section is a list of editable rows (DB-owned) or
// read-only rows mirroring helmor.json. The "Add script" button lives in
// the section header's right slot so the list itself stays a clean
// vertical stack of name+command pairs aligned with setup/archive.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
 * Run-scripts section. One section header (matching `ScriptField`'s
 * layout) plus a vertical stack of name+command pairs. The header's
 * right slot carries the "Add script" button when the list is editable,
 * mirroring how Setup carries its "Auto-run" switch in the same slot —
 * keeps each section header visually balanced.
 *
 * Each row is a flat `name input + textarea` pair (no card, no inner
 * border) so the editor column lines up with setup/archive's textarea
 * left edge. Per-row controls (Exclusive switch + delete) sit in the
 * name row's right slot.
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
				<div className="mt-3 space-y-5">
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

	const [name, setName] = useState(action.name);
	const [command, setCommand] = useState(action.command);
	const [mode, setMode] = useState<RunScriptMode>(action.mode);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);

	// Keep local state in sync when the upstream record changes (e.g. an
	// out-of-band update via UI-sync). We only overwrite the local draft
	// when the incoming value diverges — guards against clobbering the
	// caret while the user is mid-typing.
	const lastSyncedRef = useRef({
		name: action.name,
		command: action.command,
		mode: action.mode,
	});
	useEffect(() => {
		const prev = lastSyncedRef.current;
		if (prev.name !== action.name) setName(action.name);
		if (prev.command !== action.command) setCommand(action.command);
		if (prev.mode !== action.mode) setMode(action.mode);
		lastSyncedRef.current = {
			name: action.name,
			command: action.command,
			mode: action.mode,
		};
	}, [action.name, action.command, action.mode]);

	const nameInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (!autoFocus || isProjectOwned) return;
		nameInputRef.current?.focus();
		nameInputRef.current?.select();
		onFocused();
	}, [autoFocus, isProjectOwned, onFocused]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const persist = useCallback(
		(next: { name: string; command: string; mode: RunScriptMode }) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				const trimmedName = next.name.trim();
				// Drop empty-name writes — backend rejects them and we'd
				// just bounce. The red-ring affordance below tells the
				// user why nothing's persisting.
				if (!trimmedName) return;
				void updateRepoRunAction(
					repoId,
					action.id,
					trimmedName,
					next.command,
					next.mode,
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
			setConfirmOpen(false);
		}
	}, [repoId, action.id, queryClient]);

	if (isProjectOwned) {
		// Read-only branch: same `header + textarea` shape as ScriptField,
		// with the name rendered as a static label (mirrors "Setup script"
		// / "Archive script" headings). Disabled textarea + tooltip
		// explain why it's inert.
		const body = (
			<div>
				<div className="text-small font-medium text-muted-foreground">
					{action.name}
				</div>
				<Textarea
					className="mt-2 min-h-[56px] resize-y bg-app-base/30 font-mono text-small"
					value={action.command}
					readOnly
					disabled
					tabIndex={-1}
					aria-label={`${action.name} command`}
				/>
			</div>
		);
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>{body}</TooltipTrigger>
					<TooltipContent side="top">
						Set by this workspace's helmor.json — edit it there
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	const nameInvalid = !name.trim();

	return (
		<>
			<div>
				<div className="flex items-center justify-between gap-3">
					<Input
						ref={nameInputRef}
						className="h-7 w-full max-w-[220px] text-small font-medium"
						placeholder="Script name"
						value={name}
						aria-invalid={nameInvalid}
						aria-label="Script name"
						onChange={(e) => {
							const value = e.target.value;
							setName(value);
							persist({ name: value, command, mode });
						}}
					/>
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
									Only let one workspace run this script at a time. Starting a
									new run stops any other run in this repository — useful when
									the script binds a fixed port.
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
						<Switch
							checked={mode === "non-concurrent"}
							onCheckedChange={(checked) => {
								const next: RunScriptMode = checked
									? "non-concurrent"
									: "concurrent";
								setMode(next);
								persist({ name, command, mode: next });
							}}
							aria-label="Stop other runs in this repository when starting a new run"
						/>
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-7 text-muted-foreground hover:text-destructive"
										onClick={() => setConfirmOpen(true)}
										aria-label={`Delete script ${action.name || "(unnamed)"}`}
									>
										<Trash2 className="size-3.5" strokeWidth={1.8} />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">Delete script</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
				</div>
				<Textarea
					className="mt-2 min-h-[56px] resize-y bg-app-base/30 font-mono text-small"
					placeholder="e.g., npm run dev"
					value={command}
					aria-label={`${action.name || "Script"} command`}
					onChange={(e) => {
						const value = e.target.value;
						setCommand(value);
						persist({ name, command: value, mode });
					}}
				/>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Delete ${action.name || "this script"}?`}
				description={
					<>
						This removes the script from the Inspector's Run dropdown. Any PTY
						that's currently running will keep going until it exits or you stop
						it from the terminal.
					</>
				}
				confirmLabel={deleting ? "Deleting..." : "Delete"}
				onConfirm={() => void handleDelete()}
				loading={deleting}
			/>
		</>
	);
}
