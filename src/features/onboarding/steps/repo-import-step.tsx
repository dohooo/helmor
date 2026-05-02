import {
	ArrowLeft,
	ArrowRight,
	Cloud,
	FolderOpen,
	Loader2,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
	return (
		<section
			aria-label="Repository import"
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
						Bring in your first repositories
					</h2>
					<p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
						Start with a local project, or pull a remote repository from GitHub.
						You can add more than one before entering Helmor.
					</p>
				</div>

				<div className="mt-7 grid grid-cols-2 gap-3">
					<button
						type="button"
						onClick={onAddLocalRepository}
						disabled={isAddingLocalRepository}
						aria-busy={isAddingLocalRepository}
						className="flex cursor-pointer flex-col items-start rounded-lg border border-border/55 bg-card p-4 text-left text-foreground transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-card"
					>
						<div className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
							{isAddingLocalRepository ? (
								<Loader2 className="size-5 animate-spin text-muted-foreground" />
							) : (
								<FolderOpen className="size-5" />
							)}
						</div>
						<div className="mt-4 text-sm font-medium text-foreground">
							{isAddingLocalRepository
								? "Adding repository…"
								: "Choose local project"}
						</div>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							{isAddingLocalRepository
								? "Pick a folder, then we'll wire it up."
								: "Add a folder already on this machine."}
						</p>
					</button>
					<button
						type="button"
						onClick={onOpenCloneDialog}
						disabled={githubImportProgress !== null}
						className="flex cursor-pointer flex-col items-start rounded-lg border border-border/55 bg-card p-4 text-left text-foreground transition-colors hover:bg-muted/50 disabled:cursor-default disabled:opacity-70"
					>
						<div className="flex size-10 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
							<Cloud className="size-5" />
						</div>
						<div className="mt-4 text-sm font-medium text-foreground">
							Import from GitHub
						</div>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							Clone a remote project into Helmor.
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
					<p role="alert" className="mt-3 text-center text-xs text-destructive">
						{repoImportError}
					</p>
				) : null}

				<div className="mt-7 min-h-0 flex-1">
					<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
						<span>Imported repositories</span>
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
											<div className="truncate text-xs font-medium text-foreground">
												{repo.name}
											</div>
											<div className="truncate text-[11px] text-muted-foreground">
												{repo.detail}
											</div>
										</div>
										<button
											type="button"
											aria-label={`Remove ${repo.name}`}
											disabled={removingRepositoryIds.has(repo.id)}
											onClick={() => {
												onRemoveRepository(repo.id);
											}}
											className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-50"
										>
											<X className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						) : (
							<div className="flex h-full min-h-32 items-center justify-center text-center text-xs leading-5 text-muted-foreground">
								Choose a local folder or import from GitHub to build your first
								queue.
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
						className="h-11 gap-2 px-4 text-[0.95rem]"
					>
						<ArrowLeft data-icon="inline-start" className="size-4" />
						Back
					</Button>
					<Button
						type="button"
						size="lg"
						onClick={onComplete}
						className="h-11 gap-2 px-4 text-[0.95rem]"
					>
						Let&apos;s ship
						<ArrowRight data-icon="inline-end" className="size-4" />
					</Button>
				</div>
			</div>
		</section>
	);
}
