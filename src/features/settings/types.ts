// Plain type module so callers that only need types can import without
// pulling the full settings dialog tree (Tauri commands, panels, etc.)
// into their module graph.

export type SettingsSection =
	| "general"
	| "shortcuts"
	| "appearance"
	| "model"
	| "experimental"
	| "import"
	| "developer"
	| "remote-servers"
	| "runtime-debug"
	| "account"
	| "inbox"
	| `repo:${string}`;
