import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callHost } from "../host-bridge";
import { buildSystemPrompt, buildTickUserMessage } from "./prompts";
import type { TriageCandidate, TriageTickParams } from "./types";

type CandidateBody = {
	readonly candidate: TriageCandidate;
	readonly body: string;
};

export async function buildCodexTriageInput(
	params: TriageTickParams,
	cwd: string,
): Promise<Array<Record<string, unknown>>> {
	const candidateBodies = await readCandidateBodies(params.candidates);
	const prompt = buildCodexUserPrompt(params, candidateBodies);
	const imagePaths = await writeCandidateImages(params.candidates, cwd);
	return [
		{ type: "text", text: prompt, text_elements: [] },
		...imagePaths.map((path) => ({ type: "localImage", path })),
	];
}

async function readCandidateBodies(
	candidates: readonly TriageCandidate[],
): Promise<CandidateBody[]> {
	return Promise.all(
		candidates.map(async (candidate) => {
			const isIm = candidate.source === "lark" || candidate.source === "slack";
			const response = await callHost<{ body: string }>(
				"triage.read_candidate",
				{
					candidateId: candidate.id,
					...(isIm ? { tail: 80 } : {}),
				},
			);
			return { candidate, body: response.body };
		}),
	);
}

async function writeCandidateImages(
	candidates: readonly TriageCandidate[],
	cwd: string,
): Promise<string[]> {
	const dir = join(cwd, "attachments");
	const paths: string[] = [];
	let index = 0;
	for (const candidate of candidates) {
		for (const attachment of candidate.attachments ?? []) {
			if (!attachment.dataBase64 || !attachment.mimeType.startsWith("image/")) {
				continue;
			}
			await mkdir(dir, { recursive: true });
			index += 1;
			const path = join(
				dir,
				`${index}-${safeFilePart(candidate.id)}.${extensionForMime(attachment.mimeType)}`,
			);
			await writeFile(path, Buffer.from(attachment.dataBase64, "base64"));
			paths.push(path);
		}
	}
	return paths;
}

function buildCodexUserPrompt(
	params: TriageTickParams,
	candidateBodies: readonly CandidateBody[],
): string {
	const systemPrompt = buildSystemPrompt({
		userPromptSuffix: params.systemPrompt,
		maxPerTick: params.maxPerTick,
		candidates: params.candidates,
	});
	const { text: batchSummary } = buildTickUserMessage(
		params.candidates,
		params.repos,
	);
	const bodies = candidateBodies
		.map(({ candidate, body }) => {
			return `<candidate-body id="${escapeXml(candidate.id)}">
${escapeXml(body)}
</candidate-body>`;
		})
		.join("\n\n");

	return `${systemPrompt}

${batchSummary}

<candidate-bodies>
${bodies}
</candidate-bodies>

Return ONLY a JSON object with this shape:
{
  "proposals": [
    {
      "candidateId": "candidate id",
      "taskAnchor": "message id or issue/pr id",
      "repoId": "repo id",
      "title": "short title",
      "branchName": "lowercase-hyphen-branch",
      "planMessage": "markdown plan"
    }
  ],
  "skips": [
    { "candidateId": "candidate id", "reason": "one sentence" }
  ],
  "summary": "short summary"
}

Use at most ${Math.max(1, params.maxPerTick)} proposals. Include a candidate in "skips" only when the whole candidate has no actionable task.`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "candidate";
}

function extensionForMime(mime: string): string {
	if (mime === "image/jpeg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	return "png";
}
