import {
	Check,
	Circle,
	CircleDot,
	MessageSquareMore,
	PencilLine,
	X,
} from "lucide-react";
import type { UserQuestionItem, UserQuestionPart } from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
	UserQuestionPart["status"],
	{ label: string; tone: string }
> = {
	pending: { label: "Awaiting answer", tone: "bg-muted text-muted-foreground" },
	answered: { label: "Answered", tone: "bg-chart-2/10 text-chart-2" },
	declined: { label: "Declined", tone: "bg-destructive/10 text-destructive" },
	cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};

type QuestionAnswer = {
	selected: Set<string>;
	otherText: string;
};

/** Split the comma-joined answer string back into selected option labels
 *  plus any free-text remainder (same convention the composer's AUQ
 *  renderer uses to build it). */
function resolveAnswer(
	question: UserQuestionItem,
	answers: Record<string, unknown> | undefined,
): QuestionAnswer {
	const raw = answers?.[question.question];
	const text = typeof raw === "string" ? raw : "";
	const parts = text
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const labels = new Set((question.options ?? []).map((o) => o.label));
	const selected = new Set(parts.filter((part) => labels.has(part)));
	const otherText = parts.filter((part) => !labels.has(part)).join(", ");
	return { selected, otherText };
}

function QuestionBlock({
	question,
	answers,
	status,
}: {
	question: UserQuestionItem;
	answers: Record<string, unknown> | undefined;
	status: UserQuestionPart["status"];
}) {
	const { selected, otherText } = resolveAnswer(question, answers);
	const answered = status === "answered";
	const multi = question.multiSelect === true;
	// Answered cards keep only what the user picked; an open question
	// still shows every option so the card mirrors the pending panel.
	// Declined/cancelled cards show just the question text.
	const options =
		status === "pending"
			? (question.options ?? [])
			: (question.options ?? []).filter(
					(o) => answered && selected.has(o.label),
				);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-baseline gap-1.5">
				{question.header ? (
					<span className="shrink-0 text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
						{question.header}
					</span>
				) : null}
				<span className="break-words text-ui leading-5 text-muted-foreground">
					{question.question}
				</span>
			</div>
			{options.map((option) => {
				const isSelected = answered && selected.has(option.label);
				const Icon = isSelected ? (multi ? Check : CircleDot) : Circle;
				return (
					<div key={option.label} className="flex items-start gap-1.5 pl-0.5">
						<Icon
							className={cn(
								"mt-1 size-3 shrink-0",
								isSelected ? "text-chart-2" : "text-muted-foreground/40",
							)}
							strokeWidth={isSelected ? 2.2 : 1.8}
						/>
						<span
							className={cn(
								"break-words text-small leading-5",
								isSelected
									? "font-medium text-foreground"
									: "text-muted-foreground/70",
							)}
						>
							{option.label}
							{option.description ? (
								<span className="font-normal text-muted-foreground/55">
									{" "}
									— {option.description}
								</span>
							) : null}
						</span>
					</div>
				);
			})}
			{answered && otherText ? (
				<div className="flex items-start gap-1.5 pl-0.5">
					<PencilLine
						className="mt-1 size-3 shrink-0 text-chart-2"
						strokeWidth={2}
					/>
					<span className="break-words text-small font-medium leading-5 text-foreground">
						{otherText}
					</span>
				</div>
			) : null}
		</div>
	);
}

/**
 * Transcript card for a resolved (or still-open) agent→user question —
 * the persisted record of an AskUserQuestion / Codex requestUserInput /
 * OpenCode question, with the chosen answers highlighted (#796).
 */
export function UserQuestionCard({ part }: { part: UserQuestionPart }) {
	const status = STATUS_META[part.status] ?? STATUS_META.answered;

	return (
		<div className="my-1 flex flex-col gap-2 rounded-xl border-[1.5px] border-border/70 bg-background/60 px-3.5 py-3">
			<div className="flex items-center gap-1.5 text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
				<MessageSquareMore className="size-3.5" strokeWidth={1.8} />
				<span>
					<I18nText source={"Question"} />
				</span>
				{part.source ? (
					<span className="rounded-full bg-muted px-1.5 py-px font-medium normal-case tracking-normal text-muted-foreground">
						{part.source}
					</span>
				) : null}
				<span
					className={cn(
						"ml-auto flex items-center gap-1 rounded-full px-1.5 py-px font-medium normal-case tracking-normal",
						status.tone,
					)}
				>
					{part.status === "answered" ? (
						<Check className="size-3" strokeWidth={2.2} />
					) : part.status === "declined" ? (
						<X className="size-3" strokeWidth={2.2} />
					) : null}
					{status.label}
				</span>
			</div>
			{part.questions.map((question) => (
				<QuestionBlock
					key={question.question}
					question={question}
					answers={part.answers}
					status={part.status}
				/>
			))}
		</div>
	);
}
