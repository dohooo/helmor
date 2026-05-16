import "./App.css";
import "./voice-panel.css";
import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { voiceDiag } from "@/features/voice-mode/voice-diag";
import { VoiceModeBar } from "@/features/voice-mode/voice-mode-bar";
import type { VoiceUiState } from "@/features/voice-mode/voice-mode-state";
import { initDevReactScan } from "./lib/dev-react-scan";

initDevReactScan();

const VOICE_STATE_EVENT = "helmor://voice-state";

type VoicePanelState = VoiceUiState & {
	active: boolean;
};

const INACTIVE_STATE: VoicePanelState = {
	active: false,
	phase: "listening",
	level: 0,
};

function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`panel.${event}`, data);
}

function VoicePanelApp() {
	const [voiceState, setVoiceState] = useState<VoicePanelState>(INACTIVE_STATE);

	useEffect(() => {
		diag("mount");
		return () => {
			diag("unmount");
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listen<VoicePanelState>(VOICE_STATE_EVENT, (event) => {
			diag("voice-state", {
				active: event.payload.active,
				phase: event.payload.phase,
				label: event.payload.label ?? null,
				tone: event.payload.tone ?? null,
			});
			setVoiceState(event.payload);
		}).then((stop) => {
			if (cancelled) {
				stop();
				return;
			}
			unlisten = stop;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	return (
		<main aria-label="Helmor voice panel" className="voice-panel-root">
			<div className="voice-panel-bar-frame">
				<VoiceModeBar
					className="bg-muted"
					forceActive={voiceState.active}
					gap={0}
					height={32}
					stateOverride={voiceState}
				/>
			</div>
		</main>
	);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<VoicePanelApp />
	</React.StrictMode>,
);
