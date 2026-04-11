import type {
	GithubIdentityDeviceFlowStart,
	GithubIdentitySnapshot,
} from "@/lib/api";

export type GithubIdentityState =
	| { status: "checking" }
	| { status: "pending"; flow: GithubIdentityDeviceFlowStart }
	| { status: "awaiting-redirect" }
	| GithubIdentitySnapshot;
