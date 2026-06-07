// Plain type module so callers that only need types can import without
// pulling the full settings dialog tree (Tauri commands, panels, etc.)
// into their module graph.

export type SettingsSection =
	| "general"
	| "shortcuts"
	| "appearance"
	| "model"
	| "providers"
	| "experimental"
	| "import"
	| "developer"
	| "account"
	| "inbox"
	| `repo:${string}`;

// Tab inside the Inbox/Contexts panel. Exported so the shell event bus
// can carry it as a sub-route on `open-settings`.
export type ContextProviderTab =
	| "github"
	| "gitlab"
	| "linear"
	| "slack"
	| "mobile";
