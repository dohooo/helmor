import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	getTeamConfig,
	isTeamModeActive,
	pingTeamBackend,
	saveTeamConfig,
	setTeamModeActive,
} from "@/lib/team-mode";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

/**
 * Team mode panel: point Helmor at a shared cloud backend (the CF Worker) and
 * switch between Local and Team. Switching reloads the app so `ipc.ts` re-reads
 * the transport at module load (the T2 reload-style dynamic transport). The UI
 * is otherwise identical — "zero new concepts".
 */
export function TeamPanel() {
	const initial = getTeamConfig();
	const [url, setUrl] = useState(initial?.url ?? "");
	const [token, setToken] = useState(initial?.token ?? "");
	const [testing, setTesting] = useState(false);
	const active = isTeamModeActive();

	const handleTest = async () => {
		setTesting(true);
		try {
			const ok = await pingTeamBackend(url, token);
			if (ok) {
				toast.success("Connected to the team backend");
			} else {
				toast.error("Could not reach the team backend");
			}
		} finally {
			setTesting(false);
		}
	};

	const handleToggle = (next: boolean) => {
		if (next) {
			if (!url.trim()) {
				toast.error("Enter a Worker URL first");
				return;
			}
			saveTeamConfig({ url, token });
			setTeamModeActive(true);
		} else {
			setTeamModeActive(false);
		}
		// Reload so the IPC transport is rebuilt for the chosen mode.
		window.location.reload();
	};

	return (
		<SettingsGroup>
			<SettingsRow
				title="Team mode"
				description="Run against a shared cloud backend instead of this machine. The app reloads when you switch."
			>
				<Switch
					checked={active}
					onCheckedChange={handleToggle}
					aria-label="Toggle team mode"
				/>
			</SettingsRow>

			<SettingsRow
				title="Worker URL"
				description="The Cloudflare Worker that fronts your team's sandbox"
				align="start"
			>
				<Input
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://helmor-team.example.workers.dev"
					className="w-[280px]"
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
				/>
			</SettingsRow>

			<SettingsRow
				title="Access token"
				description="The capability token your team backend accepts"
				align="start"
			>
				<Input
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder="hlm_…"
					className="w-[280px]"
					autoComplete="off"
					spellCheck={false}
				/>
			</SettingsRow>

			<SettingsRow
				title="Connection"
				description="Check the backend is reachable before switching"
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void handleTest()}
					disabled={testing || !url.trim()}
				>
					{testing ? "Testing…" : "Test connection"}
				</Button>
			</SettingsRow>
		</SettingsGroup>
	);
}
