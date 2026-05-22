// Repo-level scripts section (setup / run-actions / archive). Setup and
// archive remain single-script slots and stay editable here. The Run
// section is **display-only**: rows list each action's name + command
// (read-only, scrollable textarea), no rename / delete / mode toggle.
// Users create new actions from the Inspector's Run dropdown ("Create"
// pops a pre-filled new session); existing ones get edited by chatting
// the agent or hand-editing helmor.json.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
	loadRepoScripts,
	type RunAction,
	updateRepoAutoRunSetup,
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
					// The legacy `run_script` column is no longer the
					// truth source for run actions, but we keep writing it
					// (via `updateRepoScripts`) so a downgrade still finds
					// something. Pass `null` to leave it untouched would
					// require a separate API; the column doubles as our
					// rollback safety net so writing the empty value is
					// safe.
					null,
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
		// convention). Subsequent rows are "Action N" so they're clearly
		// distinct and the user is nudged to rename them.
		const fallbackName =
			runActions.length === 0 ? "Default" : `Action ${runActions.length + 1}`;
		await createRepoRunAction(repoId, fallbackName, "", "concurrent");
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

				<RunActionsList actions={runActions} locked={runLocked} />
				{!runLocked && (
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5 text-small"
						onClick={() => void handleCreateRunAction()}
					>
						<Plus className="size-3.5" strokeWidth={1.8} />
						Add action
					</Button>
				)}

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
 * Vertical list of run actions for the current repo. Display-only —
 * rows render the action name + command in a read-only scrollable
 * textarea. Renaming / editing / deleting all happen via chat-with-agent
 * flows (Inspector "Create" dropdown) or by hand-editing helmor.json.
 */
function RunActionsList({
	actions,
	locked,
}: {
	actions: RunAction[];
	locked: boolean;
}) {
	return (
		<div>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-small font-medium text-app-foreground">
						Run actions
					</div>
					<div className="mt-0.5 text-mini text-muted-foreground">
						One per script you want to run from the Inspector's Run dropdown.
					</div>
				</div>
			</div>

			{actions.length === 0 ? (
				<div className="mt-2 rounded-md border border-dashed border-border/60 bg-app-base/30 px-3 py-4 text-center text-mini text-muted-foreground">
					No run actions yet. Click "Add action" below to create one.
				</div>
			) : (
				// Flat list. `mt-4` gives the first row room to breathe
				// after the section description; `space-y-3` keeps inter-
				// row gaps tighter (12px) since each row already has its
				// own textarea border for separation.
				<div className="mt-4 space-y-3">
					{actions.map((action) => (
						<RunActionRow key={action.id} action={action} locked={locked} />
					))}
				</div>
			)}
		</div>
	);
}

function RunActionRow({
	action,
	locked,
}: {
	action: RunAction;
	locked: boolean;
}) {
	const isProjectOwned = action.fromProject || locked;

	// Display-only row — no local state, no save logic. The textarea is
	// `readOnly` so it scrolls when the command is multi-line but never
	// accepts input. `tabIndex={-1}` keeps it out of the keyboard tab
	// order; `focus-visible:ring-0` + `cursor-default` strip the focused-
	// input affordance so it doesn't pretend to be editable.
	const rowBody = (
		<div>
			{/* Action name subheading — same size + color as the section
			    description (`text-mini text-muted-foreground`) so it stays
			    within the section's typographic rhythm, but bold so it
			    still reads as a label above the command box. */}
			<div className="text-mini font-semibold leading-tight text-muted-foreground">
				{action.name}
			</div>
			<Textarea
				className="mt-2 min-h-[56px] cursor-default resize-y bg-app-base/30 font-mono text-small focus-visible:ring-0"
				value={action.command}
				readOnly
				tabIndex={-1}
				aria-label={`${action.name} command`}
			/>
		</div>
	);

	if (!isProjectOwned) return rowBody;
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{rowBody}</TooltipTrigger>
				<TooltipContent side="top">
					Set by this workspace's helmor.json — edit it there
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
