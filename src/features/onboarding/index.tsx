import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { CloneFromUrlDialog } from "@/features/navigation/clone-from-url-dialog";
import {
	addRepositoryFromLocalPath,
	cloneRepositoryFromUrl,
	deleteRepository,
	enterOnboardingWindowMode,
	exitOnboardingWindowMode,
	getAgentLoginStatus,
	loadAddRepositoryDefaults,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { describeUnknownError } from "@/lib/workspace-helpers";
import { buildAgentLoginItems } from "./agent-login-state";
import { IntroPreview } from "./components/intro-preview";
import { OnboardingLanguageMenu } from "./components/language-menu";
import { AgentLoginStep } from "./steps/agent-login-step";
import { RepoImportStep } from "./steps/repo-import-step";
import { RepositoryCliStep } from "./steps/repository-cli-step";
import { SkillsStep } from "./steps/skills-step";
import type { ImportedRepository, OnboardingStep } from "./types";
import { basename, repositoryNameFromUrl } from "./utils";

type AppOnboardingProps = {
	onComplete: () => void;
};

// Serialize window-mode transitions so the last-issued call wins (StrictMode re-entry).
let windowModeChain: Promise<unknown> = Promise.resolve();
function queueWindowMode(run: () => Promise<unknown>): Promise<unknown> {
	const next = windowModeChain.then(run, run);
	windowModeChain = next.catch(() => {});
	return next;
}

export function AppOnboarding({ onComplete }: AppOnboardingProps) {
	const { t } = useI18n();
	const [step, setStep] = useState<OnboardingStep>("intro");
	const [loginItems, setLoginItems] = useState(() => buildAgentLoginItems());
	const [importedRepositories, setImportedRepositories] = useState<
		ImportedRepository[]
	>([]);
	const [githubImportProgress, setGithubImportProgress] = useState<
		number | null
	>(null);
	const [isAddingLocalRepository, setIsAddingLocalRepository] = useState(false);
	const [removingRepositoryIds, setRemovingRepositoryIds] = useState<
		Set<string>
	>(() => new Set());
	const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
	const [cloneDefaultDirectory, setCloneDefaultDirectory] = useState<
		string | null
	>(null);
	const [repoImportError, setRepoImportError] = useState<string | null>(null);

	const refreshLoginItems = useCallback(() => {
		void getAgentLoginStatus()
			.then((status) => {
				setLoginItems(buildAgentLoginItems(status));
			})
			.catch(() => {
				// Check failed → treat as not-connected (show Log in), not stuck on
				// "Connecting" (which `undefined` would render).
				setLoginItems(buildAgentLoginItems(null));
			});
	}, []);

	useEffect(() => {
		refreshLoginItems();
	}, [refreshLoginItems]);

	useEffect(() => {
		window.addEventListener("focus", refreshLoginItems);
		return () => {
			window.removeEventListener("focus", refreshLoginItems);
		};
	}, [refreshLoginItems]);

	useEffect(() => {
		void queueWindowMode(() =>
			enterOnboardingWindowMode().catch((error) => {
				console.error("[onboarding] failed to enter fixed window mode", error);
			}),
		);
		return () => {
			void queueWindowMode(() =>
				exitOnboardingWindowMode().catch((error) => {
					console.error("[onboarding] failed to restore window mode", error);
				}),
			);
		};
	}, []);

	const rememberImportedRepository = useCallback(
		({
			id,
			name,
			source,
			detail,
		}: {
			id: string;
			name: string;
			source: ImportedRepository["source"];
			detail: string;
		}) => {
			setImportedRepositories((current) => [
				{
					id,
					name,
					source,
					detail,
				},
				...current,
			]);
		},
		[],
	);

	const addLocalRepository = useCallback(async () => {
		if (isAddingLocalRepository) {
			return;
		}
		setIsAddingLocalRepository(true);
		setRepoImportError(null);
		try {
			const defaults = await loadAddRepositoryDefaults();
			const selection = await open({
				directory: true,
				multiple: false,
				defaultPath: defaults.lastCloneDirectory ?? undefined,
			});
			const selectedPath = Array.isArray(selection) ? selection[0] : selection;
			if (!selectedPath) {
				return;
			}
			const response = await addRepositoryFromLocalPath(selectedPath);
			rememberImportedRepository({
				id: response.repositoryId,
				name: basename(selectedPath),
				source: "local",
				detail: selectedPath,
			});
		} catch (error) {
			setRepoImportError(
				describeUnknownError(error, t("miscUnableToAddRepository")),
			);
		} finally {
			setIsAddingLocalRepository(false);
		}
	}, [isAddingLocalRepository, rememberImportedRepository, t]);

	const openCloneDialog = useCallback(() => {
		setCloneDialogOpen(true);
		setRepoImportError(null);
		void loadAddRepositoryDefaults()
			.then((defaults) => {
				setCloneDefaultDirectory(defaults.lastCloneDirectory ?? null);
			})
			.catch(() => {
				setCloneDefaultDirectory(null);
			});
	}, []);

	const handleCloneFromUrl = useCallback(
		async (args: { gitUrl: string; cloneDirectory: string }) => {
			setGithubImportProgress(0);
			let progress = 0;
			const interval = window.setInterval(() => {
				progress = Math.min(progress + 12, 92);
				setGithubImportProgress(progress);
			}, 180);
			try {
				const response = await cloneRepositoryFromUrl(args);
				window.clearInterval(interval);
				setGithubImportProgress(100);
				window.setTimeout(() => setGithubImportProgress(null), 280);
				setCloneDefaultDirectory(args.cloneDirectory);
				rememberImportedRepository({
					id: response.repositoryId,
					name: repositoryNameFromUrl(args.gitUrl),
					source: "github",
					detail: args.gitUrl,
				});
			} catch (error) {
				window.clearInterval(interval);
				setGithubImportProgress(null);
				throw error;
			}
		},
		[rememberImportedRepository],
	);

	const removeImportedRepository = useCallback(
		async (repoId: string) => {
			setRepoImportError(null);
			setRemovingRepositoryIds((current) => new Set(current).add(repoId));
			try {
				await deleteRepository(repoId);
				setImportedRepositories((current) =>
					current.filter((repo) => repo.id !== repoId),
				);
			} catch (error) {
				setRepoImportError(
					describeUnknownError(error, t("miscUnableToRemoveRepository")),
				);
			} finally {
				setRemovingRepositoryIds((current) => {
					const next = new Set(current);
					next.delete(repoId);
					return next;
				});
			}
		},
		[t],
	);

	const completeOnboarding = useCallback(() => {
		setStep("completeTransition");
		window.setTimeout(onComplete, 1100);
	}, [onComplete]);

	return (
		<main
			aria-label={t("helmorOnboarding")}
			className="relative h-dvh overflow-hidden bg-background font-sans text-foreground antialiased"
		>
			<div
				aria-label={t("helmorOnboardingDragRegion")}
				className="absolute inset-x-0 top-0 z-20 flex h-11 items-center"
			>
				<TrafficLightSpacer side="left" width={94} />
				<div data-tauri-drag-region className="h-full flex-1" />
				<div className="flex h-full items-center pr-3">
					<OnboardingLanguageMenu />
				</div>
				<TrafficLightSpacer side="right" width={140} />
			</div>

			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 opacity-[0.08]"
				style={{
					backgroundImage:
						"linear-gradient(to right, var(--color-foreground) 1px, transparent 1px), linear-gradient(to bottom, var(--color-foreground) 1px, transparent 1px)",
					backgroundSize: "42px 42px",
					maskImage:
						"radial-gradient(ellipse 82% 68% at 50% 42%, black 15%, transparent 78%)",
				}}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-background via-background/80 to-transparent"
			/>

			<IntroPreview
				step={step}
				onNext={() => {
					setStep("agents");
				}}
			/>
			<AgentLoginStep
				step={step}
				loginItems={loginItems}
				onBack={() => {
					setStep("intro");
				}}
				onNext={() => {
					setStep("corner");
				}}
				onRefreshLoginItems={refreshLoginItems}
			/>
			<RepositoryCliStep
				step={step}
				onBack={() => {
					setStep("agents");
				}}
				onNext={() => {
					setStep("skills");
				}}
			/>
			<SkillsStep
				step={step}
				onBack={() => {
					setStep("corner");
				}}
				onNext={() => {
					setStep("repoImport");
				}}
			/>
			<RepoImportStep
				step={step}
				importedRepositories={importedRepositories}
				githubImportProgress={githubImportProgress}
				isAddingLocalRepository={isAddingLocalRepository}
				removingRepositoryIds={removingRepositoryIds}
				repoImportError={repoImportError}
				onAddLocalRepository={addLocalRepository}
				onOpenCloneDialog={openCloneDialog}
				onRemoveRepository={removeImportedRepository}
				onBack={() => {
					setStep("skills");
				}}
				onComplete={completeOnboarding}
			/>
			<CloneFromUrlDialog
				open={cloneDialogOpen}
				onOpenChange={setCloneDialogOpen}
				defaultCloneDirectory={cloneDefaultDirectory}
				onSubmit={handleCloneFromUrl}
			/>
		</main>
	);
}
