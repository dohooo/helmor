import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettings } from "@/lib/settings";
import { SettingsRow } from "../components/settings-row";

// Global custom prompt: a fixed instruction prepended to every message the
// user sends (wire-only — see `globalCustomPromptPrefix` in use-streaming).
// The textarea keeps a local draft and persists on blur so we don't write
// to SQLite on every keystroke.
export function CustomPromptSetting() {
	const { settings, updateSettings } = useSettings();
	const [draft, setDraft] = useState(settings.customPrompt);

	// Re-sync the draft if the persisted value changes from elsewhere
	// (e.g. settings reload). Edits-in-progress are only clobbered when the
	// stored value actually differs, which is the intended "external change
	// wins" behaviour.
	useEffect(() => {
		setDraft(settings.customPrompt);
	}, [settings.customPrompt]);

	const commitDraft = () => {
		if (draft !== settings.customPrompt) {
			void updateSettings({ customPrompt: draft });
		}
	};

	return (
		<>
			<SettingsRow
				title="Custom prompt"
				description="Prepend a fixed instruction to every message you send to the agent. It's sent to the agent but not shown in your chat."
			>
				<Switch
					checked={settings.customPromptEnabled}
					onCheckedChange={(checked) =>
						updateSettings({ customPromptEnabled: checked })
					}
					aria-label="Enable custom prompt"
				/>
			</SettingsRow>
			{settings.customPromptEnabled ? (
				<Textarea
					className="min-h-[120px] resize-y bg-app-base/30 font-mono text-small placeholder:text-small"
					placeholder="e.g. Always respond in concise bullet points. Prefer TypeScript examples."
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commitDraft}
					aria-label="Custom prompt text"
				/>
			) : null}
		</>
	);
}
