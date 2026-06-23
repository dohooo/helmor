import {
	ArrowLeft,
	ArrowRight,
	Cloud,
	FolderOpen,
	Loader2,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { I18nText, useI18n } from "@/lib/i18n";
import type { ImportedRepository, OnboardingStep } from "../types";

export function RepoImportStep({
	step,
	importedRepositories,
	githubImportProgress,
	isAddingLocalRepository,
	removingRepositoryIds,
	repoImportError,
	onAddLocalRepository,
	onOpenCloneDialog,
	onRemoveRepository,
	onBack,
	onComplete,
}: {
	step: OnboardingStep;
	importedRepositories: ImportedRepository[];
	githubImportProgress: number | null;
	isAddingLocalRepository: boolean;
	removingRepositoryIds: Set<string>;
	repoImportError: string | null;
	onAddLocalRepository: () => void;
	onOpenCloneDialog: () => void;
	onRemoveRepository: (repoId: string) => void;
	onBack: () => void;
	onComplete: () => void;
}) {
	const { t, f } = useI18n();
	return (
		<section
			aria-label={t("repositoryImport")}
			aria-hidden={step !== "repoImport"}
			className={`absolute left-[calc(30vw-260px)] top-20 z-30 w-[520px] transition-all duration-1000 ease-[cubic-bezier(.22,.82,.2,1)] ${
				step === "repoImport"
					? "translate-x-0 translate-y-0 opacity-100"
					: step === "completeTransition"
						? "pointer-events-none -translate-x-[18vw] translate-y-[16vh] scale-[1.08] opacity-0 blur-sm"
						: "pointer-events-none translate-x-0 translate-y-0 opacity-0"
			}`}
		>
			<div className="flex h-[660px] flex-col">
				<div className="text-center">
					<h2 className="text-3xl font-semibold tracking-normal text-foreground">
						<I18nText source="bringFirstRepositories" />
					</h2>
					<p className="mx-auto mt-3 max-w-md text-body leading-6 text-muted-foreground">
						<I18nText source="startLocalProjectPullRemoteRepository" />
					</p>
				</div>

				<div className="mt-7 grid grid-cols-2 gap-3">
					<button
						type="button"
						onClick={onAddLocalRepository}
						disabled={isAddingLocalRepository}
						aria-busy={isAddingLocalRepository}
						className="flex cursor-interactive flex-col items-start rounded-lg border border-border/55 bg-card p-4 text-left text-foreground transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-card"
					>
						<div className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
							{isAddingLocalRepository ? (
								<Loader2 className="size-5 animate-spin text-muted-foreground" />
							) : (
								<FolderOpen className="size-5" />
							)}
						</div>
						<div className="mt-4 text-body font-medium text-foreground">
							{isAddingLocalRepository ? (
								<I18nText source="addingRepository" />
							) : (
								<I18nText source="chooseLocalProject" />
							)}
						</div>
						<p className="mt-1 text-small leading-5 text-muted-foreground">
							{isAddingLocalRepository ? (
								<I18nText source="pickFolderThenWeLlWire" />
							) : (
								<I18nText source="addFolderAlreadyMachine" />
							)}
						</p>
					</button>
					<button
						type="button"
						onClick={onOpenCloneDialog}
						disabled={githubImportProgress !== null}
						className="flex cursor-interactive flex-col items-start rounded-lg border border-border/55 bg-card p-4 text-left text-foreground transition-colors hover:bg-muted/50 disabled:cursor-default disabled:opacity-70"
					>
						<div className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
							<Cloud className="size-5" />
						</div>
						<div className="mt-4 text-body font-medium text-foreground">
							<I18nText source="importFromGithub" />
						</div>
						<p className="mt-1 text-small leading-5 text-muted-foreground">
							<I18nText source="cloneRemoteProjectIntoHelmor" />
						</p>
						{githubImportProgress !== null ? (
							<div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-primary transition-[width] duration-200"
									style={{ width: `${githubImportProgress}%` }}
								/>
							</div>
						) : null}
					</button>
				</div>

				{repoImportError ? (
					<p
						role="alert"
						className="mt-3 text-center text-small text-destructive"
					>
						{repoImportError}
					</p>
				) : null}

				<div className="mt-7 min-h-0 flex-1">
					<div className="mb-2 flex items-center justify-between text-small text-muted-foreground">
						<span>
							<I18nText source="importedRepositories" />
						</span>
						{importedRepositories.length > 0 ? (
							<span>{importedRepositories.length}</span>
						) : null}
					</div>
					<div className="h-full max-h-[230px] overflow-y-auto rounded-lg border border-border/55 bg-card p-2">
						{importedRepositories.length > 0 ? (
							<div className="grid gap-1.5">
								{importedRepositories.map((repo) => (
									<div
										key={repo.id}
										className="flex h-10 items-center gap-2 rounded-md border border-border/45 bg-background px-3"
									>
										{repo.source === "local" ? (
											<FolderOpen className="size-3.5 text-muted-foreground" />
										) : (
											<Cloud className="size-3.5 text-muted-foreground" />
										)}
										<div className="min-w-0 flex-1">
											<div className="truncate text-small font-medium text-foreground">
												{repo.name}
											</div>
											<div className="truncate text-mini text-muted-foreground">
												{repo.detail}
											</div>
										</div>
										<button
											type="button"
											aria-label={f("removeLabel", { label: repo.name })}
											disabled={removingRepositoryIds.has(repo.id)}
											onClick={() => {
												onRemoveRepository(repo.id);
											}}
											className="flex size-6 shrink-0 cursor-interactive items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50"
										>
											<X className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						) : (
							<div className="flex h-full min-h-32 items-center justify-center text-center text-small leading-5 text-muted-foreground">
								<I18nText source="chooseLocalFolderImportFromGithub" />
							</div>
						)}
					</div>
				</div>

				<div className="mt-7 flex items-center justify-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="lg"
						onClick={onBack}
						className="h-11 gap-2 px-4 text-title"
					>
						<ArrowLeft data-icon="inline-start" className="size-4" />
						<I18nText source="back" />
					</Button>
					<Button
						type="button"
						size="lg"
						onClick={onComplete}
						className="h-11 gap-2 px-4 text-title"
					>
						<I18nText source="letAposSShip" />
						<ArrowRight data-icon="inline-end" className="size-4" />
					</Button>
				</div>
			</div>
		</section>
	);
}
