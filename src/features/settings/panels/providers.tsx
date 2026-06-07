import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import {
	ClaudeColorIcon,
	CursorIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getAgentLoginStatus, getAgentVersions } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { SettingsGroup } from "../components/settings-row";
import { AgentProxyPanel, ClaudeCustomProvidersPanel } from "./model-providers";
import { CursorCardBody } from "./providers/cursor-card-body";
import { OpencodeCustomProvidersPanel } from "./providers/opencode-custom-providers";
import {
	OpencodeModels,
	type OpencodeModelsHandle,
} from "./providers/opencode-models";
import { ProviderConfigRow, ProviderRow } from "./providers/provider-row";

// SettingsDialog renders outside AppShell's TooltipProvider, so wrap our own.
export function ProvidersPanel() {
	const statusQuery = useQuery({
		queryKey: helmorQueryKeys.agentLoginStatus,
		queryFn: getAgentLoginStatus,
	});
	const status = statusQuery.data;
	// CLI versions change only across app builds — cache for the session.
	const versionsQuery = useQuery({
		queryKey: helmorQueryKeys.agentVersions,
		queryFn: getAgentVersions,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const versions = versionsQuery.data;
	const opencodeModelsRef = useRef<OpencodeModelsHandle | null>(null);

	const refetchStatus = () => {
		void statusQuery.refetch();
	};

	return (
		<TooltipProvider>
			<SettingsGroup>
				<ProviderRow
					icon={OpenCodeIcon}
					name="OpenCode"
					version={versions?.opencode}
					ready={Boolean(status?.opencode)}
					loginProvider="opencode"
					onLoginExit={() => {
						refetchStatus();
						opencodeModelsRef.current?.refresh();
					}}
					collapsible
				>
					<ProviderConfigRow
						label="Models"
						description="Pick which models appear in the composer's picker."
					>
						<OpencodeModels ref={opencodeModelsRef} />
					</ProviderConfigRow>
					<ProviderConfigRow
						label="Custom Providers"
						description="Add a provider with your API key, or a custom OpenAI-compatible endpoint. Saved to your global opencode config."
					>
						<OpencodeCustomProvidersPanel
							onChanged={() =>
								opencodeModelsRef.current?.refresh({ forceReload: true })
							}
						/>
					</ProviderConfigRow>
				</ProviderRow>
				<ProviderRow
					icon={ClaudeColorIcon}
					name="Claude Code"
					version={versions?.claude}
					ready={Boolean(status?.claude)}
					loginProvider="claude"
					onLoginExit={refetchStatus}
					collapsible
				>
					<ProviderConfigRow
						label="Custom Providers"
						description="Enter API keys here to use third-party models. They run alongside Claude Code's official models."
					>
						<ClaudeCustomProvidersPanel />
					</ProviderConfigRow>
				</ProviderRow>
				<ProviderRow
					icon={OpenAIIcon}
					name="Codex"
					version={versions?.codex}
					ready={Boolean(status?.codex)}
					loginProvider="codex"
					onLoginExit={refetchStatus}
				/>
				<ProviderRow
					icon={CursorIcon}
					name="Cursor"
					ready={Boolean(status?.cursor)}
					loginProvider={null}
				>
					<ProviderConfigRow description="Add your API key, then pick which models appear in the composer's picker.">
						<CursorCardBody />
					</ProviderConfigRow>
				</ProviderRow>
				<AgentProxyPanel />
			</SettingsGroup>
		</TooltipProvider>
	);
}
