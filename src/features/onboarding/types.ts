import type {
	AgentLoginItem,
	AgentLoginStatus,
} from "@/components/agent-login/types";

export type { AgentLoginItem, AgentLoginStatus };

export type OnboardingStep =
	| "intro"
	| "agents"
	| "corner"
	| "skills"
	| "conductorTransition"
	| "conductor"
	| "repoImport"
	| "completeTransition";

export type ImportedRepository = {
	id: string;
	name: string;
	source: "local" | "github";
	detail: string;
};
