import { openUrl } from "@tauri-apps/plugin-opener";
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
	ShieldQuestion,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionRowButton } from "@/components/action-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import { cn } from "@/lib/utils";
import { DeferredToolCard } from "../deferred-tool-panel/shared";
import type {
	ElicitationFormField,
	ElicitationFormViewModel,
	ElicitationResponseHandler,
	ElicitationUrlViewModel,
	UnsupportedElicitationViewModel,
} from "../elicitation";
import { normalizeElicitation } from "../elicitation";

type ElicitationPanelProps = {
	elicitation: PendingElicitation;
	disabled?: boolean;
	onResponse: ElicitationResponseHandler;
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
	message: string | null;
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
			? { blocking: true, message: "Select an answer to continue." }
			: { blocking: false, message: null };
	}

	if (field.kind === "single-select") {
		const value = responses.singleSelectValues[field.key] ?? null;
		if (value === "__other__") {
			const otherText = (responses.otherValues[field.key] ?? "").trim();
			return otherText.length === 0
				? { blocking: true, message: "Enter a custom value." }
				: { blocking: false, message: null };
		}
		return field.required && !value
			? { blocking: true, message: "Choose one option to continue." }
			: { blocking: false, message: null };
	}

	if (field.kind === "multi-select") {
		const value = responses.multiSelectValues[field.key] ?? [];
		if (field.required && value.length === 0) {
			return {
				blocking: true,
				message: "Choose at least one option to continue.",
			};
		}
		if (field.minItems !== null && value.length < field.minItems) {
			return {
				blocking: true,
				message: `Choose at least ${field.minItems} option${field.minItems === 1 ? "" : "s"}.`,
			};
		}
		if (field.maxItems !== null && value.length > field.maxItems) {
			return {
				blocking: true,
				message: `Choose no more than ${field.maxItems} option${field.maxItems === 1 ? "" : "s"}.`,
			};
		}
		return { blocking: false, message: null };
	}

	const text = (responses.stringValues[field.key] ?? "").trim();
	if (field.required && text.length === 0) {
		return { blocking: true, message: "Required" };
	}
	if (text.length === 0) {
		return { blocking: false, message: null };
	}

	if (field.kind === "string") {
		if (field.minLength !== null && text.length < field.minLength) {
			return {
				blocking: true,
				message: `Use at least ${field.minLength} character${field.minLength === 1 ? "" : "s"}.`,
			};
		}
		if (field.maxLength !== null && text.length > field.maxLength) {
			return {
				blocking: true,
				message: `Use no more than ${field.maxLength} character${field.maxLength === 1 ? "" : "s"}.`,
			};
		}
		if (field.format === "email") {
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
				? { blocking: false, message: null }
				: { blocking: true, message: "Enter a valid email address." };
		}
		if (field.format === "uri") {
			try {
				new URL(text);
				return { blocking: false, message: null };
			} catch {
				return { blocking: true, message: "Enter a valid URL." };
			}
		}
		if (field.format === "date") {
			return /^\d{4}-\d{2}-\d{2}$/.test(text)
				? { blocking: false, message: null }
				: { blocking: true, message: "Use YYYY-MM-DD." };
		}
		if (field.format === "date-time") {
			return Number.isNaN(Date.parse(text))
				? { blocking: true, message: "Enter a valid date and time." }
				: { blocking: false, message: null };
		}
		return { blocking: false, message: null };
	}

	const numericValue = Number(text);
	if (!Number.isFinite(numericValue)) {
		return { blocking: true, message: "Enter a valid number." };
	}
	if (field.kind === "integer" && !Number.isInteger(numericValue)) {
		return { blocking: true, message: "Enter a whole number." };
	}
	if (field.minimum !== null && numericValue < field.minimum) {
		return {
			blocking: true,
			message: `Use a value of at least ${field.minimum}.`,
		};
	}
	if (field.maximum !== null && numericValue > field.maximum) {
		return {
			blocking: true,
			message: `Use a value of no more than ${field.maximum}.`,
		};
	}
	return { blocking: false, message: null };
}

function getFieldPlaceholder(field: ElicitationFormField): string {
	const base = field.label;
	return field.required ? `${base} · Required` : base;
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
	elicitation,
	viewModel,
	disabled,
	onResponse,
}: {
	elicitation: PendingElicitation;
	viewModel: ElicitationFormViewModel;
	disabled: boolean;
	onResponse: ElicitationResponseHandler;
}) {
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
	const completedCount = viewModel.fields.filter(
		(field) => !fieldValidation[field.key]?.blocking,
	).length;
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

	const progressLabel = canSubmit
		? "Ready to send"
		: `${viewModel.fields.length - completedCount} field${
				viewModel.fields.length - completedCount === 1 ? "" : "s"
			} still need attention`;
	const currentValidation = currentField
		? fieldValidation[currentField.key]
		: null;

	const handleSubmit = useCallback(() => {
		const content = buildResponseContent(viewModel, responses);
		if (!content) {
			return;
		}
		onResponse(elicitation, "accept", content);
	}, [elicitation, onResponse, responses, viewModel]);

	if (!currentField) {
		return null;
	}

	return (
		<DeferredToolCard>
			<div className="flex items-start gap-3 px-1 pb-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
					<ShieldQuestion className="size-3.5" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-start gap-1.5">
						<p className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground">
							{currentField.label}
						</p>
						<span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{viewModel.serverName}
						</span>
						<span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{fieldIndex + 1}/{viewModel.fields.length}
						</span>
					</div>
					<p className="mt-1 text-[11px] text-muted-foreground">
						{currentField.description || viewModel.message}
					</p>
				</div>
				{viewModel.fields.length > 1 ? (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Previous field"
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
							aria-label="Next field"
							disabled={disabled || fieldIndex === viewModel.fields.length - 1}
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
			</div>

			{viewModel.fields.length > 1 ? (
				<div className="flex flex-wrap gap-1 px-1 pb-2">
					{viewModel.fields.map((field, index) => {
						const active = index === fieldIndex;
						const valid = !fieldValidation[field.key]?.blocking;

						return (
							<Button
								key={field.key}
								type="button"
								variant="ghost"
								size="xs"
								disabled={disabled}
								onClick={() => setFieldIndex(index)}
								className={cn(
									"rounded-full px-2.5 text-[11px]",
									active
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{valid ? <Check className="size-3" strokeWidth={2} /> : null}
								<span>{field.label}</span>
							</Button>
						);
					})}
				</div>
			) : null}

			<div className="grid gap-1 px-1">
				{currentField.kind === "string" ||
				currentField.kind === "number" ||
				currentField.kind === "integer" ? (
					<div className="rounded-lg px-2.5 py-2">
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
					</div>
				) : null}

				{currentField.kind === "boolean" ? (
					<div className="grid gap-1">
						{[
							{ label: "Yes", value: true },
							{ label: "No", value: false },
						].map((option) => {
							const selected =
								responses.booleanValues[currentField.key] === option.value;
							return (
								<div
									key={option.label}
									className={cn(
										"rounded-lg px-2.5 py-2 transition-colors",
										selected ? "bg-accent/55" : "hover:bg-accent/30",
										disabled && "opacity-60",
									)}
								>
									<button
										type="button"
										disabled={disabled}
										onClick={() =>
											updateBooleanValue(currentField.key, option.value)
										}
										className="flex w-full items-start gap-2 text-left"
									>
										<span className="mt-0.5 shrink-0 text-muted-foreground">
											{selected ? (
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
										<p className="text-[13px] font-medium text-foreground">
											{option.label}
										</p>
									</button>
								</div>
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

							return (
								<div
									key={option.value}
									className={cn(
										"rounded-lg px-2.5 py-2 transition-colors",
										selected ? "bg-accent/55" : "hover:bg-accent/30",
										disabled && "opacity-60",
									)}
								>
									<button
										type="button"
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
										className="flex w-full items-start gap-2 text-left"
									>
										<span className="mt-0.5 shrink-0 text-muted-foreground">
											{currentField.kind === "multi-select" ? (
												selected ? (
													<Check
														className="size-3.5 text-foreground"
														strokeWidth={2.4}
													/>
												) : (
													<span className="block size-3.5 rounded-[6px] bg-background/80 ring-1 ring-inset ring-border/45" />
												)
											) : selected ? (
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
										<div className="min-w-0 flex-1">
											<p className="text-[13px] font-medium text-foreground">
												{option.label}
											</p>
											{option.description ? (
												<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
													{option.description}
												</p>
											) : null}
										</div>
									</button>
								</div>
							);
						})}
						{currentField.kind === "single-select" &&
						currentField.allowOther ? (
							<div
								className={cn(
									"rounded-lg px-2.5 py-2 transition-colors",
									responses.singleSelectValues[currentField.key] === "__other__"
										? "bg-accent/55"
										: "hover:bg-accent/30",
									disabled && "opacity-60",
								)}
							>
								<div className="flex items-center gap-2">
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
										placeholder="Other"
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
										className="h-auto rounded-none border-0 !bg-transparent px-1 py-0.5 text-[13px] leading-5 shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0"
									/>
								</div>
							</div>
						) : null}
					</div>
				) : null}

				<p
					className={cn(
						"px-3 pt-1 text-[11px] leading-5 min-h-5",
						currentValidation?.message ? "text-muted-foreground" : "invisible",
					)}
				>
					{currentValidation?.message || "\u00A0"}
				</p>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 px-1 pt-2">
				<div className="text-[11px] text-muted-foreground">{progressLabel}</div>
				<div className="flex flex-wrap items-center gap-2">
					<ActionRowButton
						disabled={disabled}
						onClick={() => onResponse(elicitation, "cancel")}
					>
						<X className="size-3.5" strokeWidth={2} />
						<span>Cancel</span>
					</ActionRowButton>
					<ActionRowButton
						disabled={disabled}
						onClick={() => onResponse(elicitation, "decline")}
					>
						<Info className="size-3.5" strokeWidth={2} />
						<span>Decline</span>
					</ActionRowButton>
					<ActionRowButton
						active
						disabled={disabled || !canSubmit}
						onClick={handleSubmit}
					>
						<Check className="size-3.5" strokeWidth={2} />
						<span>Send Response</span>
					</ActionRowButton>
				</div>
			</div>
		</DeferredToolCard>
	);
}

function UrlElicitationPanel({
	elicitation,
	viewModel,
	disabled,
	onResponse,
}: {
	elicitation: PendingElicitation;
	viewModel: ElicitationUrlViewModel;
	disabled: boolean;
	onResponse: ElicitationResponseHandler;
}) {
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
		onResponse(elicitation, "accept");
	}, [elicitation, onResponse, viewModel.url]);

	return (
		<DeferredToolCard>
			<div className="flex items-start gap-3 px-1 pb-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
					<Globe className="size-3.5" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-start gap-1.5">
						<p className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground">
							{viewModel.message}
						</p>
						<span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{viewModel.serverName}
						</span>
					</div>
					<p className="mt-1 text-[11px] text-muted-foreground">
						{viewModel.host
							? `Open ${viewModel.host} to continue.`
							: "Open the requested URL to continue."}
					</p>
				</div>
			</div>

			<div className="grid gap-2 px-1 pb-2">
				<div className="rounded-lg bg-accent/35 px-3 py-2">
					<p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
						Target URL
					</p>
					<p className="mt-1 break-all text-[12px] leading-5 text-foreground">
						{viewModel.url}
					</p>
				</div>
				<div className="rounded-lg border border-border/40 bg-background/60 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
					Only continue if you trust this MCP server and understand why it needs
					an external URL.
				</div>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 px-1 pt-2">
				<div className="text-[11px] text-muted-foreground">
					{copied
						? "Link copied"
						: "Opening the link counts as accepting this request."}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<ActionRowButton
						disabled={disabled}
						onClick={() => onResponse(elicitation, "cancel")}
					>
						<X className="size-3.5" strokeWidth={2} />
						<span>Cancel</span>
					</ActionRowButton>
					<ActionRowButton
						disabled={disabled}
						onClick={() => onResponse(elicitation, "decline")}
					>
						<Info className="size-3.5" strokeWidth={2} />
						<span>Decline</span>
					</ActionRowButton>
					<ActionRowButton disabled={disabled} onClick={handleCopy}>
						<Copy className="size-3.5" strokeWidth={2} />
						<span>Copy Link</span>
					</ActionRowButton>
					<ActionRowButton
						active
						disabled={disabled}
						onClick={() => void handleOpen()}
					>
						<ExternalLink className="size-3.5" strokeWidth={2} />
						<span>Open Link</span>
					</ActionRowButton>
				</div>
			</div>
		</DeferredToolCard>
	);
}

function UnsupportedElicitationPanel({
	elicitation,
	viewModel,
	disabled,
	onResponse,
}: {
	elicitation: PendingElicitation;
	viewModel: UnsupportedElicitationViewModel;
	disabled: boolean;
	onResponse: ElicitationResponseHandler;
}) {
	return (
		<DeferredToolCard>
			<div className="flex items-start gap-3 px-1 pb-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
					<Info className="size-3.5" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<p className="text-[13px] font-medium leading-5 text-foreground">
						{viewModel.message}
					</p>
					<p className="mt-1 text-[11px] text-muted-foreground">
						{viewModel.reason}
					</p>
				</div>
			</div>
			<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/30 px-1 pt-2">
				<ActionRowButton
					disabled={disabled}
					onClick={() => onResponse(elicitation, "cancel")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>Cancel</span>
				</ActionRowButton>
				<ActionRowButton
					disabled={disabled}
					onClick={() => onResponse(elicitation, "decline")}
				>
					<Info className="size-3.5" strokeWidth={2} />
					<span>Decline</span>
				</ActionRowButton>
			</div>
		</DeferredToolCard>
	);
}

export function ElicitationPanel({
	elicitation,
	disabled = false,
	onResponse,
}: ElicitationPanelProps) {
	const viewModel = useMemo(
		() => normalizeElicitation(elicitation),
		[elicitation],
	);

	if (viewModel.kind === "url") {
		return (
			<UrlElicitationPanel
				elicitation={elicitation}
				viewModel={viewModel}
				disabled={disabled}
				onResponse={onResponse}
			/>
		);
	}

	if (viewModel.kind === "unsupported") {
		return (
			<UnsupportedElicitationPanel
				elicitation={elicitation}
				viewModel={viewModel}
				disabled={disabled}
				onResponse={onResponse}
			/>
		);
	}

	return (
		<FormElicitationPanel
			elicitation={elicitation}
			viewModel={viewModel}
			disabled={disabled}
			onResponse={onResponse}
		/>
	);
}
