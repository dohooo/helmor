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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	InteractionFooter,
	InteractionHeader,
	InteractionOptionalInput,
	InteractionOptionRow,
	InteractionStepTabs,
} from "../interaction";
import type {
	AskUserQuestionItem,
	AskUserQuestionViewModel,
} from "../user-input";
import { UserInputCard, type UserInputPanelProps } from "./shared";

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
	question: AskUserQuestionItem,
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
	question: AskUserQuestionItem,
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
		...viewModel.rawInput,
		answers,
		...(Object.keys(annotations).length > 0 ? { annotations } : {}),
	};
}

export function AskUserQuestionRenderer({
	userInput,
	disabled,
	onResponse,
	viewModel,
}: UserInputPanelProps & { viewModel: AskUserQuestionViewModel }) {
	const initialResponses = useMemo(
		() => buildInitialAskResponses(viewModel),
		[viewModel],
	);
	const [questionIndex, setQuestionIndex] = useState(0);
	const [responses, setResponses] = useState(initialResponses);
	const otherInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		setQuestionIndex(0);
		setResponses(initialResponses);
	}, [initialResponses, viewModel.userInputId]);

	const questions = viewModel.questions;
	const currentQuestion = questions[questionIndex] ?? questions[0];
	const currentResponse =
		responses[currentQuestion.key] ?? EMPTY_RESPONSE_STATE;

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

		// AUQ produces the full `updatedInput` shape directly — sidecar's
		// canUseTool resolver passes it through to the SDK unchanged.
		onResponse(userInput, "submit", {
			content: buildAskUserQuestionInput(viewModel, responses),
		});
	}, [canSubmit, userInput, onResponse, responses, viewModel]);

	return (
		<UserInputCard>
			<InteractionHeader
				icon={MessageSquareMore}
				title={currentQuestion.question}
				description={
					currentQuestion.multiSelect
						? "Choose one or more options."
						: "Choose one option."
				}
				trailing={
					<>
						{viewModel.source ? (
							<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
								{viewModel.source}
							</span>
						) : null}
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
							{questionIndex + 1}/{questions.length}
						</span>
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
					</>
				}
			/>

			<InteractionStepTabs
				items={questions.map((question) => ({
					key: question.key,
					label: question.header,
					complete: isQuestionAnswered(
						question,
						responses[question.key] ?? EMPTY_RESPONSE_STATE,
					),
				}))}
				value={currentQuestion.key}
				onChange={(value) => {
					const nextIndex = questions.findIndex((q) => q.key === value);
					if (nextIndex >= 0) setQuestionIndex(nextIndex);
				}}
				disabled={disabled}
			/>

			<div className="grid gap-1 px-1">
				{currentQuestion.options.map((option) => {
					const selected = currentResponse.selectedOptionLabels.includes(
						option.label,
					);
					const indicator = currentQuestion.multiSelect ? "checkbox" : "radio";

					return (
						<InteractionOptionRow
							key={option.label}
							data-ask-option-row={option.label}
							selected={selected}
							indicator={indicator}
							label={option.label}
							description={option.description || undefined}
							disabled={disabled}
							onClick={() => handleOptionToggle(option.label)}
						>
							{selected && option.preview ? (
								<pre className="mt-2 ml-[1.6rem] max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
									{option.preview}
								</pre>
							) : null}
						</InteractionOptionRow>
					);
				})}

				<div
					data-ask-option-row="other"
					className={cn(
						"cursor-pointer px-2 py-1.5",
						disabled && "cursor-not-allowed opacity-60",
					)}
					onClick={() => {
						if (disabled) {
							return;
						}
						handleOtherActivate();
					}}
				>
					<div className="flex items-center gap-1.5">
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

			<InteractionOptionalInput
				icon={ClipboardList}
				placeholder="Optional note for Claude"
				value={currentResponse.notes}
				onChange={(value) => {
					updateResponse(currentQuestion.key, (current) => ({
						...current,
						notes: value,
					}));
				}}
				disabled={disabled}
			/>

			<InteractionFooter>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={() => onResponse(userInput, "decline")}
				>
					<X className="size-3.5" strokeWidth={2} />
					<span>Decline</span>
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={!canSubmit}
					onClick={handleSubmitAnswers}
				>
					<Check className="size-3.5" strokeWidth={2} />
					<span>Send Answers</span>
				</Button>
			</InteractionFooter>
		</UserInputCard>
	);
}
