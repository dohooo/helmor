import {
	Check,
	ChevronLeft,
	ChevronRight,
	Circle,
	CircleDot,
	Copy,
	ExternalLink,
	Globe,
	Info,
	Settings2,
	ShieldQuestion,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import { I18nText, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { cn } from "@/lib/utils";
import type {
	ElicitationFormField,
	ElicitationFormViewModel,
	ElicitationToolApprovalViewModel,
	ElicitationUrlViewModel,
	UnsupportedElicitationViewModel,
} from "../elicitation-schema";
import { normalizeElicitation } from "../elicitation-schema";
import {
	InteractionFooter,
	InteractionHeader,
	InteractionOptionRow,
	InteractionStepTabs,
} from "../interaction";
import type { UserInputResponseHandler } from "../user-input";
import { UserInputCard } from "./shared";

type ElicitationPanelProps = {
	userInput: PendingUserInput;
	disabled?: boolean;
	onResponse: UserInputResponseHandler;
};

type FormResponseState = {
	stringValues: Record<string, string>;
	booleanValues: Record<string, boolean | null>;
	singleSelectValues: Record<string, string | null>;
	multiSelectValues: Record<string, string[]>;
	otherValues: Record<string, string>;
};

type FieldValidationState = {
	blocking: boolean;
	/** Catalog key for the message, or null when there is no message. */
	messageKey: string | null;
	/** Interpolation values for the message key. */
	messageValues?: Record<string, number>;
};

function buildInitialResponseState(
	viewModel: ElicitationFormViewModel,
): FormResponseState {
	const next: FormResponseState = {
		stringValues: {},
		booleanValues: {},
		singleSelectValues: {},
		multiSelectValues: {},
		otherValues: {},
	};

	for (const field of viewModel.fields) {
		switch (field.kind) {
			case "string":
			case "number":
			case "integer":
				next.stringValues[field.key] = field.defaultValue;
				break;
			case "boolean":
				next.booleanValues[field.key] = field.defaultValue;
				break;
			case "single-select":
				next.singleSelectValues[field.key] = field.defaultValue;
				break;
			case "multi-select":
				next.multiSelectValues[field.key] = [...field.defaultValue];
				break;
		}
	}

	return next;
}

function getFieldValidationState(
	field: ElicitationFormField,
	responses: FormResponseState,
): FieldValidationState {
	if (field.kind === "boolean") {
		const value = responses.booleanValues[field.key] ?? null;
		return field.required && value === null
			? { blocking: true, messageKey: "selectAnswerContinue" }
			: { blocking: false, messageKey: null };
	}

	if (field.kind === "single-select") {
		const value = responses.singleSelectValues[field.key] ?? null;
		if (value === "__other__") {
			const otherText = (responses.otherValues[field.key] ?? "").trim();
			return otherText.length === 0
				? { blocking: true, messageKey: "enterCustomValue" }
				: { blocking: false, messageKey: null };
		}
		return field.required && !value
			? { blocking: true, messageKey: "chooseOneOptionContinue" }
			: { blocking: false, messageKey: null };
	}

	if (field.kind === "multi-select") {
		const value = responses.multiSelectValues[field.key] ?? [];
		if (field.required && value.length === 0) {
			return {
				blocking: true,
				messageKey: "chooseLeastOneOptionContinue",
			};
		}
		if (field.minItems !== null && value.length < field.minItems) {
			return {
				blocking: true,
				messageKey: "composerChooseAtLeastOptions",
				messageValues: { count: field.minItems },
			};
		}
		if (field.maxItems !== null && value.length > field.maxItems) {
			return {
				blocking: true,
				messageKey: "composerChooseNoMoreOptions",
				messageValues: { count: field.maxItems },
			};
		}
		return { blocking: false, messageKey: null };
	}

	const text = (responses.stringValues[field.key] ?? "").trim();
	if (field.required && text.length === 0) {
		return { blocking: true, messageKey: null };
	}
	if (text.length === 0) {
		return { blocking: false, messageKey: null };
	}

	if (field.kind === "string") {
		if (field.minLength !== null && text.length < field.minLength) {
			return {
				blocking: true,
				messageKey: "composerUseAtLeastCharacters",
				messageValues: { count: field.minLength },
			};
		}
		if (field.maxLength !== null && text.length > field.maxLength) {
			return {
				blocking: true,
				messageKey: "composerUseNoMoreCharacters",
				messageValues: { count: field.maxLength },
			};
		}
		if (field.format === "email") {
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
				? { blocking: false, messageKey: null }
				: { blocking: true, messageKey: "enterValidEmailAddress" };
		}
		if (field.format === "uri") {
			try {
				new URL(text);
				return { blocking: false, messageKey: null };
			} catch {
				return { blocking: true, messageKey: "enterValidUrl" };
			}
		}
		if (field.format === "date") {
			return /^\d{4}-\d{2}-\d{2}$/.test(text)
				? { blocking: false, messageKey: null }
				: { blocking: true, messageKey: "useYyyyMmDd" };
		}
		if (field.format === "date-time") {
			return Number.isNaN(Date.parse(text))
				? { blocking: true, messageKey: "enterValidDateTime" }
				: { blocking: false, messageKey: null };
		}
		return { blocking: false, messageKey: null };
	}

	const numericValue = Number(text);
	if (!Number.isFinite(numericValue)) {
		return { blocking: true, messageKey: "enterValidNumber" };
	}
	if (field.kind === "integer" && !Number.isInteger(numericValue)) {
		return { blocking: true, messageKey: "enterWholeNumber" };
	}
	if (field.minimum !== null && numericValue < field.minimum) {
		return {
			blocking: true,
			messageKey: "composerUseValueAtLeast",
			messageValues: { count: field.minimum },
		};
	}
	if (field.maximum !== null && numericValue > field.maximum) {
		return {
			blocking: true,
			messageKey: "composerUseValueNoMore",
			messageValues: { count: field.maximum },
		};
	}
	return { blocking: false, messageKey: null };
}

function getFieldPlaceholder(field: ElicitationFormField): string {
	return field.label;
}

function buildResponseContent(
	viewModel: ElicitationFormViewModel,
	responses: FormResponseState,
): Record<string, unknown> | null {
	const content: Record<string, unknown> = {};

	for (const field of viewModel.fields) {
		const validation = getFieldValidationState(field, responses);
		if (validation.blocking) {
			return null;
		}

		switch (field.kind) {
			case "string": {
				const value = (responses.stringValues[field.key] ?? "").trim();
				if (value.length > 0) {
					content[field.key] = value;
				}
				break;
			}
			case "number":
			case "integer": {
				const value = (responses.stringValues[field.key] ?? "").trim();
				if (value.length > 0) {
					content[field.key] = Number(value);
				}
				break;
			}
			case "boolean": {
				const value = responses.booleanValues[field.key] ?? null;
				if (value !== null) {
					content[field.key] = value;
				}
				break;
			}
			case "single-select": {
				const value = responses.singleSelectValues[field.key] ?? null;
				if (value === "__other__") {
					const otherText = (responses.otherValues[field.key] ?? "").trim();
					if (otherText) {
						content[field.key] = otherText;
					}
				} else if (value) {
					content[field.key] = value;
				}
				break;
			}
			case "multi-select": {
				const value = responses.multiSelectValues[field.key] ?? [];
				if (value.length > 0) {
					content[field.key] = value;
				}
				break;
			}
		}
	}

	return content;
}

function FormElicitationPanel({
	userInput,
	viewModel,
	disabled,
	onResponse,
}: {
	userInput: PendingUserInput;
	viewModel: ElicitationFormViewModel;
	disabled: boolean;
	onResponse: UserInputResponseHandler;
}) {
	const { t, f } = useI18n();
	const [fieldIndex, setFieldIndex] = useState(0);
	const [responses, setResponses] = useState<FormResponseState>(() =>
		buildInitialResponseState(viewModel),
	);

	useEffect(() => {
		setFieldIndex(0);
		setResponses(buildInitialResponseState(viewModel));
	}, [viewModel]);

	const currentField = viewModel.fields[fieldIndex] ?? viewModel.fields[0];
	const fieldValidation = useMemo(
		() =>
			Object.fromEntries(
				viewModel.fields.map((field) => [
					field.key,
					getFieldValidationState(field, responses),
				]),
			),
		[responses, viewModel.fields],
	);
	const canSubmit = viewModel.fields.every(
		(field) => !fieldValidation[field.key]?.blocking,
	);

	const updateStringValue = useCallback((key: string, value: string) => {
		setResponses((current) => ({
			...current,
			stringValues: {
				...current.stringValues,
				[key]: value,
			},
		}));
	}, []);

	const updateBooleanValue = useCallback((key: string, value: boolean) => {
		setResponses((current) => ({
			...current,
			booleanValues: {
				...current.booleanValues,
				[key]: value,
			},
		}));
	}, []);

	const updateSingleSelectValue = useCallback((key: string, value: string) => {
		setResponses((current) => ({
			...current,
			singleSelectValues: {
				...current.singleSelectValues,
				[key]: value,
			},
		}));
	}, []);

	const toggleMultiSelectValue = useCallback((key: string, value: string) => {
		setResponses((current) => {
			const selected = new Set(current.multiSelectValues[key] ?? []);
			if (selected.has(value)) {
				selected.delete(value);
			} else {
				selected.add(value);
			}

			return {
				...current,
				multiSelectValues: {
					...current.multiSelectValues,
					[key]: Array.from(selected),
				},
			};
		});
	}, []);

	const updateOtherValue = useCallback((key: string, value: string) => {
		setResponses((current) => ({
			...current,
			singleSelectValues: {
				...current.singleSelectValues,
				[key]: "__other__",
			},
			otherValues: {
				...current.otherValues,
				[key]: value,
			},
		}));
	}, []);

	const currentValidation = currentField
		? fieldValidation[currentField.key]
		: null;
	const currentValidationMessage = currentValidation?.messageKey
		? currentValidation.messageValues
			? f(currentValidation.messageKey, currentValidation.messageValues)
			: t(currentValidation.messageKey)
		: null;

	const handleSubmit = useCallback(() => {
		const content = buildResponseContent(viewModel, responses);
		if (!content) {
			return;
		}
		onResponse(userInput, "submit", { content });
	}, [userInput, onResponse, responses, viewModel]);

	if (!currentField) {
		return null;
	}

	return (
		<UserInputCard>
			<InteractionHeader
				icon={ShieldQuestion}
				title={currentField.label}
				description={currentField.description || viewModel.message}
				trailing={
					<>
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
							{viewModel.serverName}
						</span>
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
							{fieldIndex + 1}/{viewModel.fields.length}
						</span>
						{viewModel.fields.length > 1 ? (
							<div className="flex shrink-0 items-center gap-1">
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label="previousField"
									disabled={disabled || fieldIndex === 0}
									onClick={() =>
										setFieldIndex((current) => Math.max(0, current - 1))
									}
								>
									<ChevronLeft className="size-3.5" strokeWidth={2} />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label="nextField"
									disabled={
										disabled || fieldIndex === viewModel.fields.length - 1
									}
									onClick={() =>
										setFieldIndex((current) =>
											Math.min(viewModel.fields.length - 1, current + 1),
										)
									}
								>
									<ChevronRight className="size-3.5" strokeWidth={2} />
								</Button>
							</div>
						) : null}
					</>
				}
			/>

			<InteractionStepTabs
				items={viewModel.fields.map((field) => ({
					key: field.key,
					label: field.label,
					complete: !fieldValidation[field.key]?.blocking,
					required: field.required,
				}))}
				value={currentField.key}
				onChange={(value) => {
					const nextIndex = viewModel.fields.findIndex((f) => f.key === value);
					if (nextIndex >= 0) setFieldIndex(nextIndex);
				}}
				disabled={disabled}
			/>

			<div className="grid gap-1 px-1">
				{currentField.kind === "string" ||
				currentField.kind === "number" ||
				currentField.kind === "integer" ? (
					<Input
						disabled={disabled}
						type={
							currentField.kind === "string"
								? currentField.format === "email"
									? "email"
									: currentField.format === "uri"
										? "url"
										: currentField.format === "date"
											? "date"
											: currentField.format === "date-time"
												? "datetime-local"
												: "text"
								: "number"
						}
						step={currentField.kind === "integer" ? 1 : undefined}
						value={responses.stringValues[currentField.key] ?? ""}
						onChange={(event) =>
							updateStringValue(currentField.key, event.target.value)
						}
						placeholder={getFieldPlaceholder(currentField)}
						className="border-border/55 bg-background/70 placeholder:text-muted-foreground/70"
					/>
				) : null}

				{currentField.kind === "boolean" ? (
					<div className="grid gap-1">
						{[
							{ label: "yes", value: true },
							{ label: "no", value: false },
						].map((option) => {
							const selected =
								responses.booleanValues[currentField.key] === option.value;
							return (
								<InteractionOptionRow
									key={option.label}
									selected={selected}
									indicator="radio"
									label={option.label}
									onClick={() =>
										updateBooleanValue(currentField.key, option.value)
									}
									disabled={disabled}
								/>
							);
						})}
					</div>
				) : null}

				{currentField.kind === "single-select" ||
				currentField.kind === "multi-select" ? (
					<div className="grid gap-1">
						{currentField.options.map((option) => {
							const selected =
								currentField.kind === "single-select"
									? responses.singleSelectValues[currentField.key] ===
										option.value
									: (
											responses.multiSelectValues[currentField.key] ?? []
										).includes(option.value);
							const indicator =
								currentField.kind === "multi-select" ? "checkbox" : "radio";

							return (
								<InteractionOptionRow
									key={option.value}
									selected={selected}
									indicator={indicator}
									label={option.label}
									description={option.description || undefined}
									disabled={disabled}
									onClick={() => {
										if (currentField.kind === "single-select") {
											updateSingleSelectValue(currentField.key, option.value);
											if (fieldIndex < viewModel.fields.length - 1) {
												setFieldIndex(fieldIndex + 1);
											}
										} else {
											toggleMultiSelectValue(currentField.key, option.value);
										}
									}}
								/>
							);
						})}
						{currentField.kind === "single-select" &&
						currentField.allowOther ? (
							<div
								className={cn(
									"rounded-md px-2 py-1.5 transition-colors",
									responses.singleSelectValues[currentField.key] === "__other__"
										? "bg-accent/55"
										: "hover:bg-accent/30",
									disabled && "opacity-60",
								)}
							>
								<div className="flex items-center gap-1.5">
									<span className="mt-0.5 shrink-0 text-muted-foreground">
										{responses.singleSelectValues[currentField.key] ===
										"__other__" ? (
											<CircleDot
												className="size-3.5 text-foreground"
												strokeWidth={1.9}
											/>
										) : (
											<Circle
												className="size-3.5 text-muted-foreground/60"
												strokeWidth={1.9}
											/>
										)}
									</span>
									<Input
										disabled={disabled}
										placeholder="other"
										value={responses.otherValues[currentField.key] ?? ""}
										onFocus={() => {
											if (
												responses.singleSelectValues[currentField.key] !==
												"__other__"
											) {
												updateOtherValue(
													currentField.key,
													responses.otherValues[currentField.key] ?? "",
												);
											}
										}}
										onChange={(event) =>
											updateOtherValue(currentField.key, event.target.value)
										}
										className="h-auto rounded-none border-0 !bg-transparent px-1 py-0.5 text-ui leading-5 shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0"
									/>
								</div>
							</div>
						) : null}
					</div>
				) : null}

				<p
					className={cn(
						"px-3 pt-1 text-mini leading-5 min-h-5",
						currentValidationMessage ? "text-muted-foreground" : "invisible",
					)}
				>
					{currentValidationMessage || "\u00A0"}
				</p>
			</div>

			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "cancel")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>{t("cancel")}</span>
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "decline")}
				>
					<Info className="size-3.5" strokeWidth={2} />
					<span>{t("decline")}</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled || !canSubmit}
					onClick={handleSubmit}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>{t("sendResponse")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}

function UrlElicitationPanel({
	userInput,
	viewModel,
	disabled,
	onResponse,
}: {
	userInput: PendingUserInput;
	viewModel: ElicitationUrlViewModel;
	disabled: boolean;
	onResponse: UserInputResponseHandler;
}) {
	const { t, f } = useI18n();
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
			return;
		}

		void navigator.clipboard.writeText(viewModel.url).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	}, [viewModel.url]);

	const handleOpen = useCallback(async () => {
		await openUrl(viewModel.url);
		onResponse(userInput, "submit");
	}, [userInput, onResponse, viewModel.url]);

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Globe}
				title={viewModel.message}
				description={
					viewModel.host
						? f("composerOpenHostToContinue", { host: viewModel.host })
						: t("openRequestedUrlContinue")
				}
				trailing={
					<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
						{viewModel.serverName}
					</span>
				}
			/>

			<div className="grid gap-2 px-1 pb-2">
				<div className="rounded-lg bg-accent/35 px-3 py-2">
					<p className="text-mini uppercase tracking-[0.08em] text-muted-foreground">
						<I18nText source="targetUrl" />
					</p>
					<p className="mt-1 break-all text-small leading-5 text-foreground">
						{viewModel.url}
					</p>
				</div>
				<div className="rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-small leading-5 text-muted-foreground">
					<I18nText source="onlyContinueIfTrustMcpServer" />
				</div>
			</div>

			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "cancel")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>{t("cancel")}</span>
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "decline")}
				>
					<Info className="size-3.5" strokeWidth={2} />
					<span>{t("decline")}</span>
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={handleCopy}
				>
					{copied ? (
						<Check className="size-3.5" strokeWidth={2} />
					) : (
						<Copy className="size-3.5" strokeWidth={2} />
					)}
					<span>{copied ? t("copied") : t("composerCopyLink")}</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={disabled}
					onClick={() => void handleOpen()}
				>
					<ExternalLink className="size-3.5" strokeWidth={2} />
					<span>{t("openLink")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}

/**
 * Codex MCP tool-call approval panel. Negative path sends `"decline"`
 * (not `"cancel"`) so the agent's error reads "user rejected" and it
 * tries a different approach instead of treating the turn as aborted.
 */
function ToolApprovalElicitationPanel({
	userInput,
	viewModel,
	disabled,
	onResponse,
}: {
	userInput: PendingUserInput;
	viewModel: ElicitationToolApprovalViewModel;
	disabled: boolean;
	onResponse: UserInputResponseHandler;
}) {
	const { t } = useI18n();
	const handleAccept = useCallback(
		(persist: "session" | "always" | null) => {
			onResponse(userInput, "submit", {
				content: {},
				...(persist ? { meta: { persist } } : {}),
			});
		},
		[userInput, onResponse],
	);

	return (
		<UserInputCard>
			<InteractionHeader
				icon={Settings2}
				title={viewModel.serverName}
				description={viewModel.message || t("composerMcpToolNeedsApproval")}
			/>

			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "decline")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>{t("decline")}</span>
				</Button>
				{viewModel.allowAlways ? (
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
						onClick={() => handleAccept("always")}
					>
						<Check className="size-3.5" strokeWidth={2} />
						<span>{t("alwaysAllow")}</span>
					</Button>
				) : null}
				{viewModel.allowSession ? (
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
						onClick={() => handleAccept("session")}
					>
						<Check className="size-3.5" strokeWidth={2} />
						<span>{t("allowSession")}</span>
					</Button>
				) : null}
				<Button
					variant="default"
					size="sm"
					disabled={disabled}
					onClick={() => handleAccept(null)}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>{t("allow")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}

function UnsupportedElicitationPanel({
	userInput,
	viewModel,
	disabled,
	onResponse,
}: {
	userInput: PendingUserInput;
	viewModel: UnsupportedElicitationViewModel;
	disabled: boolean;
	onResponse: UserInputResponseHandler;
}) {
	const { t } = useI18n();
	return (
		<UserInputCard>
			<InteractionHeader
				icon={Info}
				title={viewModel.message}
				description={viewModel.reason}
			/>
			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "cancel")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>{t("cancel")}</span>
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "decline")}
				>
					<Info className="size-3.5" strokeWidth={2} />
					<span>{t("decline")}</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}

/**
 * Render either the form, URL, or unsupported view from a unified
 * `PendingUserInput` whose payload is `form` or `url`. The top-level
 * UserInputPanel dispatcher routes here for those two payload kinds;
 * AskUserQuestion has its own renderer.
 */
export function ElicitationRenderer({
	userInput,
	disabled = false,
	onResponse,
}: ElicitationPanelProps) {
	const viewModel = useMemo(() => normalizeElicitation(userInput), [userInput]);

	if (viewModel.kind === "url") {
		return (
			<UrlElicitationPanel
				userInput={userInput}
				viewModel={viewModel}
				disabled={disabled}
				onResponse={onResponse}
			/>
		);
	}

	if (viewModel.kind === "tool-approval") {
		return (
			<ToolApprovalElicitationPanel
				userInput={userInput}
				viewModel={viewModel}
				disabled={disabled}
				onResponse={onResponse}
			/>
		);
	}

	if (viewModel.kind === "unsupported") {
		return (
			<UnsupportedElicitationPanel
				userInput={userInput}
				viewModel={viewModel}
				disabled={disabled}
				onResponse={onResponse}
			/>
		);
	}

	return (
		<FormElicitationPanel
			userInput={userInput}
			viewModel={viewModel}
			disabled={disabled}
			onResponse={onResponse}
		/>
	);
}
