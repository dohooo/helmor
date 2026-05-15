import "./App.css";
import "./voice-panel.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { VoiceModeBar } from "@/features/voice-mode/voice-mode-bar";
import { initDevReactScan } from "./lib/dev-react-scan";

initDevReactScan();

function VoicePanelApp() {
	return (
		<main aria-label="Helmor voice panel" className="voice-panel-root">
			<div className="voice-panel-bar-frame">
				<VoiceModeBar className="bg-muted" forceActive gap={0} height={32} />
			</div>
		</main>
	);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<VoicePanelApp />
	</React.StrictMode>,
);
