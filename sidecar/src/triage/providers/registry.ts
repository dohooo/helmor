// Single source of truth for which providers exist.

import { githubProvider } from "./github";
import { gitlabProvider } from "./gitlab";
import { larkProvider } from "./lark";
import { slackProvider } from "./slack";
import type { TriageProvider } from "./types";

export const PROVIDERS: readonly TriageProvider[] = [
	slackProvider,
	larkProvider,
	gitlabProvider,
	githubProvider,
];

export function findProvider(id: string): TriageProvider | undefined {
	return PROVIDERS.find((p) => p.id === id);
}
