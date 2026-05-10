import { Mic } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/lib/settings";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";

export function OpenAiRealtimePanel() {
	const { settings, updateSettings } = useSettings();

	return (
		<SettingsGroup>
			<SettingsRow
				title="OpenAI Realtime"
				description="API key used to mint short-lived browser tokens for voice mode."
			>
				<Input
					aria-label="OpenAI Realtime API key"
					autoComplete="off"
					className="w-[280px]"
					onChange={(event) =>
						updateSettings({
							openAiRealtimeApiKey: event.target.value,
						})
					}
					placeholder="sk-..."
					type="password"
					value={settings.openAiRealtimeApiKey}
				/>
			</SettingsRow>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<Mic className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
						<span>Microphone Access</span>
					</span>
				}
				description={
					<>
						Voice mode needs macOS microphone permission for Helmor. Enable it
						in System Settings → Privacy & Security → Microphone, then restart
						Helmor if macOS asks you to.
						<SettingsNotice tone="info">
							In development builds, launch Helmor from Warp, Terminal, or
							iTerm. macOS can deny microphone access when Helmor is launched
							from Helmor's built-in terminal.
						</SettingsNotice>
					</>
				}
			/>
		</SettingsGroup>
	);
}
