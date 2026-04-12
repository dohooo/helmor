import {
	Check,
	ChevronLeft,
	ChevronRight,
	Circle,
	CircleDot,
	ClipboardList,
	MessageSquareMore,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionRowButton } from "@/components/action-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
	AskUserQuestionViewModel,
	DeferredQuestion,
} from "../deferred-tool";
import {
	autosizeTextarea,
	DeferredToolCard,
	type DeferredToolPanelProps,
	INLINE_TEXTAREA_CLASS,
} from "./shared";

type AskQuestionResponseState = {
	selectedOptionLabels: string[];
	useOther: boolean;
	otherText: string;
	notes: string;
};

const EMPTY_RESPONSE_STATE: AskQuestionResponseState = {
	selectedOptionLabels: [],
	useOther: false,
	otherText: "",
	notes: "",
};

function buildInitialAskResponses(
	viewModel: AskUserQuestionViewModel,
): Record<string, AskQuestionResponseState> {
	const next: Record<string, AskQuestionResponseState> = {};

	for (const question of viewModel.questions) {
		const existingAnswer = viewModel.answers[question.question] ?? "";
		const parts = existingAnswer
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
		const optionLabels = new Set(
			question.options.map((option) => option.label),
		);
		const selectedOptionLabels = parts.filter((part) => optionLabels.has(part));
		const otherParts = parts.filter((part) => !optionLabels.has(part));
		const annotation = viewModel.annotations[question.question];

		next[question.key] = {
			selectedOptionLabels,
			useOther: otherParts.length > 0,
			otherText: otherParts.join(", "),
			notes: annotation?.notes ?? "",
		};
	}

	return next;
}

function buildAnswerString(
	question: DeferredQuestion,
	response: AskQuestionResponseState,
): string {
	const selectedLabels = question.multiSelect
		? response.selectedOptionLabels
		: response.selectedOptionLabels.slice(0, 1);
	const parts = [...selectedLabels];
	if (response.useOther && response.otherText.trim()) {
		if (question.multiSelect) {
			parts.push(response.otherText.trim());
		} else {
			return response.otherText.trim();
		}
	}

	return parts.join(", ");
}

function isQuestionAnswered(
	question: DeferredQuestion,
	response: AskQuestionResponseState,
): boolean {
	return buildAnswerString(question, response).trim().length > 0;
}

function buildAskUserQuestionInput(
	viewModel: AskUserQuestionViewModel,
	responses: Record<string, AskQuestionResponseState>,
): Record<string, unknown> {
	const answers: Record<string, string> = {};
	const annotations: Record<string, { preview?: string; notes?: string }> = {};

	for (const question of viewModel.questions) {
		const response = responses[question.key] ?? EMPTY_RESPONSE_STATE;
		const answer = buildAnswerString(question, response).trim();
		if (!answer) {
			continue;
		}

		answers[question.question] = answer;
		const selectedPreview = question.options.find(
			(option) =>
				response.selectedOptionLabels.includes(option.label) &&
				option.preview !== null,
		)?.preview;
		const notes = response.notes.trim();
		if (selectedPreview || notes) {
			annotations[question.question] = {
				...(selectedPreview ? { preview: selectedPreview } : {}),
				...(notes ? { notes } : {}),
			};
		}
	}

	return {
		...viewModel.toolInput,
		answers,
		...(Object.keys(annotations).length > 0 ? { annotations } : {}),
	};
}

export function AskUserQuestionPanel({
	deferred,
	disabled,
	onResponse,
	viewModel,
}: DeferredToolPanelProps & { viewModel: AskUserQuestionViewModel }) {
	const initialResponses = useMemo(
		() => buildInitialAskResponses(viewModel),
		[viewModel],
	);
	const [questionIndex, setQuestionIndex] = useState(0);
	const [responses, setResponses] = useState(initialResponses);
	const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const otherInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		setQuestionIndex(0);
		setResponses(initialResponses);
	}, [initialResponses, viewModel.toolUseId]);

	const questions = viewModel.questions;
	const currentQuestion = questions[questionIndex] ?? questions[0];
	const currentResponse =
		responses[currentQuestion.key] ?? EMPTY_RESPONSE_STATE;

	useEffect(() => {
		autosizeTextarea(noteTextareaRef.current);
	}, [currentQuestion.key, currentResponse.notes]);

	const answeredCount = questions.filter((question) =>
		isQuestionAnswered(
			question,
			responses[question.key] ?? EMPTY_RESPONSE_STATE,
		),
	).length;
	const canSubmit = answeredCount === questions.length && !disabled;

	const updateResponse = useCallback(
		(
			questionKey: string,
			updater: (current: AskQuestionResponseState) => AskQuestionResponseState,
		) => {
			setResponses((current) => ({
				...current,
				[questionKey]: updater(current[questionKey] ?? EMPTY_RESPONSE_STATE),
			}));
		},
		[],
	);

	const handleOptionToggle = useCallback(
		(optionLabel: string) => {
			updateResponse(currentQuestion.key, (current) => {
				const selected = new Set(current.selectedOptionLabels);
				if (currentQuestion.multiSelect) {
					if (selected.has(optionLabel)) {
						selected.delete(optionLabel);
					} else {
						selected.add(optionLabel);
					}

					return {
						...current,
						selectedOptionLabels: Array.from(selected),
					};
				}

				return {
					...current,
					selectedOptionLabels: [optionLabel],
					useOther: false,
					otherText: "",
				};
			});

			if (
				!currentQuestion.multiSelect &&
				questionIndex < questions.length - 1
			) {
				setQuestionIndex(questionIndex + 1);
			}
		},
		[currentQuestion, questionIndex, questions.length, updateResponse],
	);

	const handleOtherActivate = useCallback(() => {
		updateResponse(currentQuestion.key, (current) => ({
			...current,
			selectedOptionLabels: currentQuestion.multiSelect
				? current.selectedOptionLabels
				: [],
			useOther: true,
		}));

		window.requestAnimationFrame(() => {
			otherInputRef.current?.focus();
		});
	}, [currentQuestion, updateResponse]);

	const handleSubmitAnswers = useCallback(() => {
		if (!canSubmit) {
			return;
		}

		onResponse(deferred, "allow", {
			updatedInput: buildAskUserQuestionInput(viewModel, responses),
		});
	}, [canSubmit, deferred, onResponse, responses, viewModel]);
	const remainingCount = questions.length - answeredCount;
	const progressLabel =
		remainingCount === 0
			? "Ready to send"
			: `Answer ${remainingCount} more question${remainingCount === 1 ? "" : "s"}`;

	return (
		<DeferredToolCard>
			<div className="flex items-start gap-3 px-1 pb-2">
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
					<MessageSquareMore className="size-3.5" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-start gap-1.5">
						<p className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground">
							{currentQuestion.question}
						</p>
						{viewModel.source ? (
							<span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
								{viewModel.source}
							</span>
						) : null}
						<span className="rounded-full bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{questionIndex + 1}/{questions.length}
						</span>
					</div>
					<p className="mt-1 text-[11px] text-muted-foreground">
						{currentQuestion.multiSelect
							? "Choose one or more options."
							: "Choose one option."}
					</p>
				</div>
				{questions.length > 1 ? (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Previous question"
							disabled={disabled || questionIndex === 0}
							onClick={() =>
								setQuestionIndex((current) => Math.max(0, current - 1))
							}
						>
							<ChevronLeft className="size-3.5" strokeWidth={2} />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Next question"
							disabled={disabled || questionIndex === questions.length - 1}
							onClick={() =>
								setQuestionIndex((current) =>
									Math.min(questions.length - 1, current + 1),
								)
							}
						>
							<ChevronRight className="size-3.5" strokeWidth={2} />
						</Button>
					</div>
				) : null}
			</div>

			{questions.length > 1 ? (
				<div className="flex flex-wrap gap-1 px-1 pb-2">
					{questions.map((question, index) => {
						const answered = isQuestionAnswered(
							question,
							responses[question.key] ?? EMPTY_RESPONSE_STATE,
						);
						const active = index === questionIndex;

						return (
							<Button
								key={question.key}
								type="button"
								variant="ghost"
								size="xs"
								disabled={disabled}
								onClick={() => setQuestionIndex(index)}
								className={cn(
									"rounded-full px-2.5 text-[11px]",
									active
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{answered ? <Check className="size-3" strokeWidth={2} /> : null}
								<span>{question.header}</span>
							</Button>
						);
					})}
				</div>
			) : null}

			<div className="grid gap-1 px-1">
				{currentQuestion.options.map((option) => {
					const selected = currentResponse.selectedOptionLabels.includes(
						option.label,
					);

					return (
						<div
							key={option.label}
							data-ask-option-row={option.label}
							className={cn(
								"rounded-lg px-2.5 py-2 transition-colors",
								selected ? "bg-accent/55" : "hover:bg-accent/30",
								disabled && "opacity-60",
							)}
						>
							<button
								type="button"
								disabled={disabled}
								aria-pressed={selected}
								onClick={() => handleOptionToggle(option.label)}
								className="flex w-full items-start gap-2 text-left"
							>
								<span className="mt-0.5 shrink-0 text-muted-foreground">
									{currentQuestion.multiSelect ? (
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
									<div className="flex items-center gap-2">
										<p className="text-[13px] font-medium text-foreground">
											{option.label}
										</p>
										{selected ? (
											<span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
												Selected
											</span>
										) : null}
									</div>
									{option.description ? (
										<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
											{option.description}
										</p>
									) : null}
								</div>
							</button>
							{selected && option.preview ? (
								<pre className="mt-2 ml-[1.6rem] max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
									{option.preview}
								</pre>
							) : null}
						</div>
					);
				})}

				<div
					data-ask-option-row="other"
					className={cn("px-2.5 py-2", disabled && "opacity-60")}
					onClick={() => {
						if (disabled) {
							return;
						}
						handleOtherActivate();
					}}
				>
					<div className="flex items-center gap-2">
						<span className="mt-0.5 shrink-0 text-muted-foreground">
							{currentQuestion.multiSelect ? (
								currentResponse.useOther ? (
									<Check
										className="size-3.5 text-foreground"
										strokeWidth={2.4}
									/>
								) : (
									<span className="block size-3.5 rounded-[6px] bg-background/80 ring-1 ring-inset ring-border/45" />
								)
							) : currentResponse.useOther ? (
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
							ref={otherInputRef}
							aria-label={`Other answer for ${currentQuestion.header}`}
							disabled={disabled}
							placeholder="Other"
							value={currentResponse.otherText}
							onFocus={() => {
								if (!currentResponse.useOther) {
									handleOtherActivate();
								}
							}}
							onBlur={() => {
								if (currentResponse.otherText.trim().length > 0) {
									return;
								}
								updateResponse(currentQuestion.key, (current) => ({
									...current,
									useOther: false,
									otherText: "",
								}));
							}}
							onClick={(event) => {
								event.stopPropagation();
							}}
							onChange={(event) => {
								const value = event.target.value;
								updateResponse(currentQuestion.key, (current) => ({
									...current,
									selectedOptionLabels: currentQuestion.multiSelect
										? current.selectedOptionLabels
										: [],
									useOther: true,
									otherText: value,
								}));
							}}
							className="h-auto rounded-none border-0 !bg-transparent px-1 py-0.5 text-[13px] leading-5 shadow-none placeholder:text-muted-foreground/55 focus-visible:ring-0 disabled:!bg-transparent dark:!bg-transparent dark:disabled:!bg-transparent"
						/>
					</div>
				</div>
			</div>

			<div className="px-1 pb-2 pt-2">
				<div className="flex items-start gap-2 px-2 py-1.5">
					<ClipboardList
						className="mt-1 size-3.5 shrink-0 text-muted-foreground/70"
						strokeWidth={1.8}
					/>
					<Textarea
						ref={noteTextareaRef}
						rows={1}
						aria-label="Optional note for Claude"
						disabled={disabled}
						placeholder="Optional note for Claude"
						value={currentResponse.notes}
						onChange={(event) => {
							const value = event.target.value;
							updateResponse(currentQuestion.key, (current) => ({
								...current,
								notes: value,
							}));
						}}
						className={INLINE_TEXTAREA_CLASS}
					/>
				</div>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 px-1 pt-2">
				<div className="text-[11px] text-muted-foreground">{progressLabel}</div>
				<div className="flex flex-wrap items-center gap-2">
					<ActionRowButton
						disabled={disabled}
						onClick={() => onResponse(deferred, "deny")}
					>
						<X className="size-3.5" strokeWidth={2} />
						<span>Decline</span>
					</ActionRowButton>
					<ActionRowButton
						active
						disabled={!canSubmit}
						onClick={handleSubmitAnswers}
					>
						<Check className="size-3.5" strokeWidth={2} />
						<span>Send Answers</span>
					</ActionRowButton>
				</div>
			</div>
		</DeferredToolCard>
	);
}
