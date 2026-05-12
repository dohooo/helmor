// Repo-level scripts section (setup / run / archive). Each script edit is
// debounced 600ms before persisting; auto-run + exclusive toggles persist
// immediately. When `helmor.json` declares any script the corresponding
// textarea becomes read-only and a tooltip explains why.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	loadRepoScripts,
	updateRepoAutoRunSetup,
	updateRepoRunScriptMode,
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

	const [setupScript, setSetupScript] = useState("");
	const [runScript, setRunScript] = useState("");
	const [archiveScript, setArchiveScript] = useState("");
	const [autoRunSetup, setAutoRunSetup] = useState(false);
	const [runExclusive, setRunExclusive] = useState(false);
	const initialized = useRef(false);

	useEffect(() => {
		if (!data) return;
		const shouldSyncSetup = setupLocked || !initialized.current;
		const shouldSyncRun = runLocked || !initialized.current;
		const shouldSyncArchive = archiveLocked || !initialized.current;
		if (shouldSyncSetup) setSetupScript(data.setupScript ?? "");
		if (shouldSyncRun) setRunScript(data.runScript ?? "");
		if (shouldSyncArchive) setArchiveScript(data.archiveScript ?? "");
		if (!initialized.current) {
			setAutoRunSetup(data.autoRunSetup);
			setRunExclusive(data.runScriptMode === "non-concurrent");
		}
		if (!setupLocked && !runLocked && !archiveLocked) {
			initialized.current = true;
		}
	}, [data, setupLocked, runLocked, archiveLocked]);

	// Reset when switching repos.
	useEffect(() => {
		initialized.current = false;
	}, [repoId]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const save = useCallback(
		(nextSetup: string, nextRun: string, nextArchive: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepoScripts(
					repoId,
					nextSetup.trim() || null,
					nextRun.trim() || null,
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
			save(value, runScript, archiveScript);
		},
		[runScript, archiveScript, save],
	);

	const handleRunChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setRunScript(value);
			save(setupScript, value, archiveScript);
		},
		[setupScript, archiveScript, save],
	);

	const handleArchiveChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setArchiveScript(value);
			save(setupScript, runScript, value);
		},
		[setupScript, runScript, save],
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

	const handleRunExclusiveChange = useCallback(
		(checked: boolean) => {
			setRunExclusive(checked);
			void updateRepoRunScriptMode(
				repoId,
				checked ? "non-concurrent" : "concurrent",
			).then(() => {
				void queryClient.invalidateQueries({
					queryKey: ["repoScripts", repoId],
				});
			});
		},
		[repoId, queryClient],
	);

	const setupHasScript = !!setupScript.trim();
	const runHasScript = !!runScript.trim();

	return (
		<div className="py-5">
			<div className="text-[13px] font-medium leading-snug text-foreground">
				Scripts
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
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
							<span className="text-[11px] font-medium text-muted-foreground">
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
				<ScriptField
					label="Run script"
					description="Runs when you click the play button"
					placeholder="e.g., npm run dev"
					value={runScript}
					locked={runLocked}
					lockedMessage="Set by this workspace's helmor.json — edit it there"
					onChange={handleRunChange}
					headerRight={
						<div className="flex items-center gap-1.5">
							<span className="text-[11px] font-medium text-muted-foreground">
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
								checked={runExclusive}
								onCheckedChange={handleRunExclusiveChange}
								disabled={!runHasScript}
								aria-label="Stop other runs in this repository when starting a new run"
							/>
						</div>
					}
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
			className="mt-2 min-h-[72px] resize-y bg-app-base/30 font-mono text-[12px]"
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
					<div className="text-[12px] font-medium text-app-foreground">
						{label}
					</div>
					<div className="mt-0.5 text-[11px] text-muted-foreground">
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
