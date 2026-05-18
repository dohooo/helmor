import {
	ChevronDown,
	CloudIcon,
	FileCode2,
	GitPullRequestArrow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { mockInspector } from "./data";
import {
	InspectorActionGroupTitleUI,
	InspectorActionRowUI,
} from "./ui/inspector-action-row.ui";
import { InspectorChangeRowUI } from "./ui/inspector-change-row.ui";
import { InspectorFolderHeaderUI } from "./ui/inspector-folder-header.ui";
import { InspectorSectionUI } from "./ui/inspector-section.ui";
import { InspectorShellUI } from "./ui/inspector-shell.ui";
import {
	InspectorTabsHeaderUI,
	InspectorTabsLogsUI,
} from "./ui/inspector-tabs-section.ui";

/**
 * Onboarding mock inspector — composes the real `.ui.tsx` primitives
 * (shell + section + folder header + change row + action row + tabs section)
 * with static mock data.
 */
export function MockInspector({
	gitHeaderSpotlight = false,
}: {
	gitHeaderSpotlight?: boolean;
} = {}) {
	return (
		<InspectorShellUI>
			<InspectorSectionUI
				title="Git"
				containerClassName="h-[270px]"
				headerClassName={
					gitHeaderSpotlight
						? "rounded-tr-[16px] relative z-40 isolate bg-sidebar"
						: "rounded-tr-[16px]"
				}
				bodyClassName="bg-muted/20 font-mono text-[11.5px]"
				rightSlot={
					<Button
						variant="outline"
						size="sm"
						className="h-6 gap-1 px-2 text-[12px]"
					>
						<GitPullRequestArrow className="size-3.5" />
						Create PR
						<ChevronDown className="size-3 opacity-50" />
					</Button>
				}
			>
				<InspectorFolderHeaderUI
					icon={
						<CloudIcon
							className="size-3 shrink-0 text-muted-foreground"
							strokeWidth={2}
						/>
					}
					label="Remote"
					count={mockInspector.changes.length}
					open
				/>
				<div className="pl-3">
					{mockInspector.changes.map((change) => (
						<InspectorChangeRowUI
							key={change.path}
							name={change.name}
							path={change.path}
							status={change.status}
							icon={
								<FileCode2
									className="size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.8}
								/>
							}
							insertions={change.insertions}
							deletions={change.deletions}
						/>
					))}
				</div>
			</InspectorSectionUI>

			<InspectorSectionUI
				title="Actions"
				containerClassName="h-[250px]"
				bodyClassName="bg-muted/18 text-[11.5px]"
			>
				<InspectorActionGroupTitleUI>Git</InspectorActionGroupTitleUI>
				{mockInspector.gitActions.map((item) => (
					<InspectorActionRowUI
						key={item.label}
						label={item.label}
						status={item.status}
						actionLabel={item.action}
					/>
				))}
				<InspectorActionGroupTitleUI>Review</InspectorActionGroupTitleUI>
				{mockInspector.reviewActions.map((item) => (
					<InspectorActionRowUI
						key={item.label}
						label={item.label}
						status={item.status}
						actionLabel={item.action}
					/>
				))}
			</InspectorSectionUI>

			<section className="flex min-h-0 flex-1 flex-col bg-sidebar">
				<InspectorTabsHeaderUI
					tabs={[
						{ id: "setup", label: "Setup" },
						{ id: "run", label: "Run" },
					]}
					activeTabId="setup"
				/>
				<InspectorTabsLogsUI
					entries={[
						{ kind: "cmd", text: "helmor scripts run setup" },
						{ kind: "step", text: "pnpm install (312 pkg, 2.4s)" },
						{ kind: "step", text: "Running drizzle-kit migrate" },
						{ kind: "success", text: "Database migrated" },
						{ kind: "step", text: "Seeding test users" },
						{ kind: "success", text: "Seed inserted 12 rows" },
						{ kind: "step", text: "Booting dev server on :3000" },
						{ kind: "success", text: "Ready in 1.2s" },
					]}
				/>
			</section>
		</InspectorShellUI>
	);
}
