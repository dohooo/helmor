// Branch-prefix selector — radio between username / custom / none, with a
// debounced custom-input save and a live preview chip. State + persistence
// stay local; the panel only emits `onChanged` when the backend write
// commits so the parent can refetch the repos list.
import { useCallback, useEffect, useRef, useState } from "react";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	type BranchPrefixType,
	type RepositoryCreateOption,
	updateRepositoryBranchPrefix,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const PREFIX_TYPES: BranchPrefixType[] = ["username", "custom", "none"];

function effectivePrefixType(repo: RepositoryCreateOption): BranchPrefixType {
	const stored = repo.branchPrefixType;
	if (stored === "username" || stored === "custom" || stored === "none") {
		return stored;
	}
	// NULL is treated as "username" by the backend resolver — mirror here so
	// the radio reflects the value the workspace branch generator will use.
	return "username";
}

export function BranchPrefixSection({
	repo,
	githubLogin,
	onChanged,
}: {
	repo: RepositoryCreateOption;
	githubLogin: string | null;
	onChanged: () => void;
}) {
	const initialType = effectivePrefixType(repo);
	const [prefixType, setPrefixType] = useState<BranchPrefixType>(initialType);
	const [customPrefix, setCustomPrefix] = useState(
		repo.branchPrefixCustom ?? "",
	);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Reset local state when switching repos. Keying on `repo.id` (not the
	// whole `repo` object) is intentional: a same-repo refresh would
	// otherwise overwrite the user's in-progress custom typing.
	useEffect(() => {
		setPrefixType(effectivePrefixType(repo));
		setCustomPrefix(repo.branchPrefixCustom ?? "");
	}, [repo.id]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, [repo.id]);

	const persist = useCallback(
		(type: BranchPrefixType, custom: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepositoryBranchPrefix(
					repo.id,
					type,
					type === "custom" ? custom.trim() || null : null,
				).then(onChanged);
			}, 400);
		},
		[repo.id, onChanged],
	);

	const handleTypeChange = useCallback(
		(value: string) => {
			if (!PREFIX_TYPES.includes(value as BranchPrefixType)) return;
			const next = value as BranchPrefixType;
			setPrefixType(next);
			// Switching mode is intent — persist immediately rather than
			// debouncing (debounce is for in-progress typing).
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			void updateRepositoryBranchPrefix(
				repo.id,
				next,
				next === "custom" ? customPrefix.trim() || null : null,
			).then(onChanged);
		},
		[customPrefix, onChanged, repo.id],
	);

	const handleCustomChange = useCallback(
		(value: string) => {
			setCustomPrefix(value);
			persist("custom", value);
		},
		[persist],
	);

	const previewBase = "tokyo";
	const previewPrefix =
		prefixType === "custom"
			? customPrefix.trim()
			: prefixType === "username"
				? githubLogin
					? `${githubLogin}/`
					: ""
				: "";

	const customId = `repo-${repo.id}-branch-prefix-custom`;
	const customActive = prefixType === "custom";

	const activateCustom = useCallback(() => {
		if (prefixType === "custom") return;
		setPrefixType("custom");
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		void updateRepositoryBranchPrefix(
			repo.id,
			"custom",
			customPrefix.trim() || null,
		).then(onChanged);
	}, [customPrefix, onChanged, prefixType, repo.id]);

	return (
		<div className="py-5">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-medium leading-snug text-foreground">
						Branch prefix
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						Prefix added to branch names when creating new workspaces in this
						repo.
					</div>
				</div>
				<BranchPrefixPreview
					prefixType={prefixType}
					previewPrefix={previewPrefix}
					previewBase={previewBase}
				/>
			</div>
			<RadioGroup
				value={prefixType}
				onValueChange={handleTypeChange}
				className="mt-3 gap-0"
			>
				<PrefixRadioOption repoId={repo.id} value="username" label="Username" />
				{/* Custom row inlines its own input so the panel height stays fixed
				 * across all three options. When Custom isn't selected the input
				 * is hidden via `invisible` (NOT unmounted) — that keeps it
				 * occupying the same vertical footprint. */}
				<Field
					orientation="horizontal"
					className="items-center gap-3 rounded-lg px-1 py-0.5"
				>
					<RadioGroupItem value="custom" id={customId} />
					<FieldLabel htmlFor={customId} className="shrink-0 text-foreground">
						Custom
					</FieldLabel>
					<Input
						type="text"
						value={customPrefix}
						onChange={(event) => handleCustomChange(event.target.value)}
						onFocus={() => activateCustom()}
						placeholder="e.g. feat/"
						aria-label="Custom branch prefix"
						aria-hidden={!customActive}
						tabIndex={customActive ? 0 : -1}
						className={cn(
							"h-7 w-48 bg-muted/30 text-[13px] text-foreground placeholder:text-muted-foreground/50",
							!customActive && "invisible pointer-events-none",
						)}
					/>
				</Field>
				<PrefixRadioOption repoId={repo.id} value="none" label="None" />
			</RadioGroup>
		</div>
	);
}

/// Right-aligned preview chip rendered next to the section title. Pulled
/// out so the title row stays at a fixed height regardless of which radio
/// mode is active (None hides the chip via `invisible`, not unmount, so
/// the row's metrics don't shift).
function BranchPrefixPreview({
	prefixType,
	previewPrefix,
	previewBase,
}: {
	prefixType: BranchPrefixType;
	previewPrefix: string;
	previewBase: string;
}) {
	const hidden = prefixType === "none";
	return (
		<div
			className={cn(
				"shrink-0 text-[12px] leading-snug text-muted-foreground",
				hidden && "invisible",
			)}
			aria-hidden={hidden}
		>
			Preview:{" "}
			<span className="font-mono text-foreground/80">
				{previewPrefix}
				{previewBase}
			</span>
			{prefixType === "username" && !previewPrefix ? (
				<span className="ml-1 text-muted-foreground/70">
					(connect an account)
				</span>
			) : null}
		</div>
	);
}

function PrefixRadioOption({
	repoId,
	value,
	label,
}: {
	repoId: string;
	value: BranchPrefixType;
	label: string;
}) {
	const id = `repo-${repoId}-branch-prefix-${value}`;
	return (
		<Field
			orientation="horizontal"
			className="items-center gap-3 rounded-lg px-1 py-0.5"
		>
			<RadioGroupItem value={value} id={id} />
			<FieldContent>
				<FieldLabel htmlFor={id} className="text-foreground">
					{label}
				</FieldLabel>
			</FieldContent>
		</Field>
	);
}
