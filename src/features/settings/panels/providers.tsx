import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import {
	ClaudeColorIcon,
	type ClaudeIcon,
	CursorIcon,
	KimiIcon,
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
	KIMI_CONFIG_ADAPTER,
	MIMO_CONFIG_ADAPTER,
	OPENCODE_CONFIG_ADAPTER,
} from "./providers/adapters";
import { CursorCardBody } from "./providers/cursor-card-body";
import { CustomProvidersList } from "./providers/custom-providers-list";
import { KimiModels } from "./providers/kimi-models";
import { LoginGate } from "./providers/login-gate";
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
import { useKimiModelSync } from "./providers/use-kimi-model-sync";

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
	// Kimi's isSyncing is already global (useIsMutating inside the hook), so a
	// sync from any panel spins this row too; sync after login so the models
	// panel isn't empty until a manual Sync.
	const { sync: syncKimiModels, isSyncing: kimiSyncing } = useKimiModelSync();

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
					icon={KimiIcon}
					name="Kimi"
					version={versions?.kimi}
					ready={Boolean(status?.kimi)}
					connecting={statusLoading || kimiSyncing}
					loginProvider="kimi"
					onLoginExit={() => {
						refetchStatus();
						void syncKimiModels().catch(() => {});
					}}
					collapsible
				>
					{/* Kimi runs over ACP, which rejects every session until you sign in
					    — even custom providers. Lock the whole section until then. */}
					<LoginGate
						locked={!statusLoading && !status?.kimi}
						message="settingsSignInToKimiEvenCustom"
					>
						<ProviderConfigRow
							label="models"
							description="settingsPickWhichKimiModelsAppearComposer"
						>
							<KimiModels />
						</ProviderConfigRow>
						<ProviderConfigRow
							label="customProviders"
							description={KIMI_CONFIG_ADAPTER.customProvidersDescription}
						>
							<CustomProvidersList adapter={KIMI_CONFIG_ADAPTER} />
						</ProviderConfigRow>
					</LoginGate>
				</ProviderRow>
				<ProviderRow
					icon={CursorIcon}
					name="Cursor"
					ready={Boolean(status?.cursor)}
					loginProvider={null}
				>
					<ProviderConfigRow description="addApiKeyThenPickWhich">
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
				label="models"
				description="pickWhichModelsAppearComposerS"
			>
				<SlugProviderModels adapter={adapter} ref={modelsRef} />
			</ProviderConfigRow>
			<ProviderConfigRow
				label="customProviders"
				description={configAdapter.customProvidersDescription}
			>
				<CustomProvidersList adapter={configAdapter} />
			</ProviderConfigRow>
		</ProviderRow>
	);
}
