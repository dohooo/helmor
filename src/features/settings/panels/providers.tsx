import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import {
	ClaudeColorIcon,
	type ClaudeIcon,
	CursorIcon,
	MiMoCodeIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getAgentLoginStatus, getAgentVersions } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { SettingsGroup } from "../components/settings-row";
import { AgentProxyPanel } from "./model-providers";
import {
	CLAUDE_ADAPTER,
	CODEX_ADAPTER,
	MIMO_CONFIG_ADAPTER,
	OPENCODE_CONFIG_ADAPTER,
} from "./providers/adapters";
import { CursorCardBody } from "./providers/cursor-card-body";
import { CustomProvidersList } from "./providers/custom-providers-list";
import {
	SlugProviderModels,
	type SlugProviderModelsHandle,
} from "./providers/opencode-models";
import type { ProviderConfigAdapter } from "./providers/provider-config";
import { ProviderConfigRow, ProviderRow } from "./providers/provider-row";
import { ProviderConfigSection } from "./providers/provider-section";
import {
	MIMO_ADAPTER,
	OPENCODE_ADAPTER,
	type SlugProviderAdapter,
} from "./providers/slug-provider-adapter";

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

	// First status fetch in flight → show "Connecting…" instead of a premature
	// "Log in". opencode-protocol providers also stay connecting while a model
	// sync (server boot) runs, since their readiness is derived from that
	// fetch's cache.
	const statusLoading = statusQuery.isLoading;

	const refetchStatus = () => {
		void statusQuery.refetch();
	};

	return (
		<TooltipProvider>
			<SettingsGroup>
				<SlugProviderRow
					adapter={OPENCODE_ADAPTER}
					configAdapter={OPENCODE_CONFIG_ADAPTER}
					icon={OpenCodeIcon}
					version={versions?.opencode}
					ready={Boolean(status?.opencode)}
					statusLoading={statusLoading}
					onRefetchStatus={refetchStatus}
				/>
				<SlugProviderRow
					adapter={MIMO_ADAPTER}
					configAdapter={MIMO_CONFIG_ADAPTER}
					icon={MiMoCodeIcon}
					version={versions?.mimo}
					ready={Boolean(status?.mimo)}
					statusLoading={statusLoading}
					onRefetchStatus={refetchStatus}
				/>
				<ProviderRow
					icon={ClaudeColorIcon}
					name="Claude Code"
					version={versions?.claude}
					ready={Boolean(status?.claude)}
					connecting={statusLoading}
					loginProvider="claude"
					onLoginExit={refetchStatus}
					collapsible
				>
					<ProviderConfigSection adapter={CLAUDE_ADAPTER} />
				</ProviderRow>
				<ProviderRow
					icon={OpenAIIcon}
					name="Codex"
					version={versions?.codex}
					ready={Boolean(status?.codex)}
					connecting={statusLoading}
					loginProvider="codex"
					onLoginExit={refetchStatus}
					collapsible
				>
					<ProviderConfigSection adapter={CODEX_ADAPTER} />
				</ProviderRow>
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

// Row for an opencode-protocol provider (OpenCode / MiMo Code): Models picker
// + Custom Providers editor, wired through the provider's adapter.
function SlugProviderRow({
	adapter,
	configAdapter,
	icon,
	version,
	ready,
	statusLoading,
	onRefetchStatus,
}: {
	adapter: SlugProviderAdapter;
	configAdapter: ProviderConfigAdapter;
	icon: typeof ClaudeIcon;
	version: string | null | undefined;
	ready: boolean;
	statusLoading: boolean;
	onRefetchStatus: () => void;
}) {
	const modelsRef = useRef<SlugProviderModelsHandle | null>(null);
	const syncing =
		useIsMutating({ mutationKey: [...adapter.modelSyncMutationKey] }) > 0;

	return (
		<ProviderRow
			icon={icon}
			name={adapter.displayName}
			version={version}
			ready={ready}
			connecting={statusLoading || syncing}
			loginProvider={adapter.provider}
			onLoginExit={() => {
				onRefetchStatus();
				modelsRef.current?.refresh();
			}}
			collapsible
		>
			<ProviderConfigRow
				label="Models"
				description="Pick which models appear in the composer's picker."
			>
				<SlugProviderModels adapter={adapter} ref={modelsRef} />
			</ProviderConfigRow>
			<ProviderConfigRow
				label="Custom Providers"
				description={configAdapter.customProvidersDescription}
			>
				<CustomProvidersList adapter={configAdapter} />
			</ProviderConfigRow>
		</ProviderRow>
	);
}
