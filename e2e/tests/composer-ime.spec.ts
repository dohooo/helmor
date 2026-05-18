import { expect, test } from "@playwright/test";

test.describe("composer IME regressions", () => {
	test("keeps stripped ASCII text and trailing caret across the next Lexical render", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			window.__HELMOR_E2E__ = {
				invokeOverrides: {
					get_app_settings: () => ({ "app.onboarding_completed": "true" }),
					list_agent_model_sections: () => [
						{
							id: "claude",
							label: "Claude",
							options: [
								{
									id: "opus-1m",
									provider: "claude",
									label: "Opus 4.7 1M",
									cliModel: "opus-1m",
									effortLevels: ["low", "medium", "high", "max"],
									supportsFastMode: true,
								},
							],
						},
					],
					list_workspace_groups: () => [
						{
							id: "in-progress",
							label: "In Progress",
							tone: "progress",
							rows: [
								{
									id: "workspace-ime",
									title: "IME workspace",
									directoryName: "ime-workspace",
									repoName: "helmor",
									state: "ready",
									hasUnread: false,
									workspaceUnread: 0,
									sessionUnreadTotal: 0,
									unreadSessionCount: 0,
									derivedStatus: "in-progress",
									manualStatus: null,
									branch: "ime-fix",
									activeSessionId: "session-ime",
									activeSessionTitle: "IME session",
									activeSessionAgentType: "codex",
									activeSessionStatus: "idle",
									sessionCount: 1,
									messageCount: 0,
								},
							],
						},
					],
					list_archived_workspaces: () => [],
					get_workspace: () => ({
						id: "workspace-ime",
						title: "IME workspace",
						repoId: "repo-ime",
						repoName: "helmor",
						repoIconSrc: null,
						repoInitials: "H",
						remote: "origin",
						remoteUrl: "git@github.com:example/helmor.git",
						defaultBranch: "main",
						rootPath: "/tmp/ime-workspace",
						directoryName: "ime-workspace",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						sessionUnreadTotal: 0,
						unreadSessionCount: 0,
						derivedStatus: "in-progress",
						manualStatus: null,
						activeSessionId: "session-ime",
						activeSessionTitle: "IME session",
						activeSessionAgentType: "codex",
						activeSessionStatus: "idle",
						branch: "ime-fix",
						initializationParentBranch: "main",
						intendedTargetBranch: "main",
						pinnedAt: null,
						prTitle: null,
						archiveCommit: null,
						sessionCount: 1,
						messageCount: 0,
					}),
					list_workspace_sessions: () => [
						{
							id: "session-ime",
							workspaceId: "workspace-ime",
							title: "IME session",
							agentType: "codex",
							status: "idle",
							model: "opus-1m",
							permissionMode: "acceptEdits",
							providerSessionId: null,
							effortLevel: "high",
							unreadCount: 0,
							fastMode: false,
							createdAt: "2026-04-21T00:00:00.000Z",
							updatedAt: "2026-04-21T00:00:00.000Z",
							lastUserMessageAt: null,
							isHidden: false,
							actionKind: null,
							active: true,
						},
					],
					list_session_thread_messages: () => [],
					get_app_update_status: () => ({ status: "idle" }),
					update_app_settings: () => null,
					trigger_workspace_fetch: () => null,
					prewarm_slash_commands_for_workspace: () => null,
					load_repo_scripts: () => null,
					list_workspace_linked_directories: () => [],
					list_workspace_candidate_directories: () => [],
					get_auto_close_action_kinds: () => [],
					get_auto_close_opt_in_asked: () => false,
				},
			};
		});

		await page.goto("/");
		await expect(
			page.getByRole("tab", { name: "IME session", selected: true }),
		).toBeVisible();

		const editor = page.getByLabel("Workspace input");
		await expect(editor).toBeVisible();
		await editor.click();

		const timeline = await page.evaluate(async () => {
			const editor = document.querySelector(
				'[aria-label="Workspace input"]',
			) as HTMLElement | null;
			if (!editor) {
				throw new Error("Workspace input not found");
			}

			const paragraph = editor.querySelector("p");
			if (!paragraph) {
				throw new Error("Composer paragraph not found");
			}

			const snapshot = (label: string) => {
				const sel = window.getSelection();
				return {
					label,
					text: editor.textContent ?? "",
					anchorNode: sel?.anchorNode?.nodeName ?? null,
					anchorOffset: sel?.anchorOffset ?? null,
				};
			};

			const collapseToEnd = (text: string) => {
				paragraph.textContent = text;
				const textNode = paragraph.firstChild;
				const sel = window.getSelection();
				if (textNode && sel) {
					const range = document.createRange();
					range.setStart(textNode, text.length);
					range.setEnd(textNode, text.length);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			};

			const flushMicrotasks = () =>
				new Promise<void>((resolve) => {
					setTimeout(() => resolve(), 0);
				});

			const getLexicalEditor = () => {
				const key = Object.keys(editor).find((entry) =>
					entry.startsWith("__lexicalEditor"),
				);
				if (!key) {
					throw new Error("Lexical editor instance not found on root element");
				}
				return (editor as Record<string, unknown>)[key] as {
					update: (fn: () => void) => void;
				};
			};

			editor.focus();

			editor.dispatchEvent(
				new CompositionEvent("compositionstart", {
					data: "",
					bubbles: true,
					cancelable: true,
				}),
			);
			collapseToEnd("he lmor");
			editor.dispatchEvent(
				new CompositionEvent("compositionupdate", {
					data: "he lmor",
					bubbles: true,
					cancelable: true,
				}),
			);
			editor.dispatchEvent(
				new CompositionEvent("compositionend", {
					data: "he lmor",
					bubbles: true,
					cancelable: true,
				}),
			);
			await flushMicrotasks();

			const afterAsciiCommit = snapshot("after-ascii-commit");
			getLexicalEditor().update(() => {});
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => resolve());
				});
			});
			const afterNoopUpdate = snapshot("after-noop-update");

			return [afterAsciiCommit, afterNoopUpdate];
		});

		expect(timeline).toEqual([
			{
				label: "after-ascii-commit",
				text: "helmor",
				anchorNode: "#text",
				anchorOffset: 6,
			},
			{
				label: "after-noop-update",
				text: "helmor",
				anchorNode: "#text",
				anchorOffset: 6,
			},
		]);
	});

	test("does not leave a blank placeholder after switching from Chinese IME to English with existing Chinese text", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			window.__HELMOR_E2E__ = {
				invokeOverrides: {
					get_app_settings: () => ({ "app.onboarding_completed": "true" }),
					list_agent_model_sections: () => [
						{
							id: "claude",
							label: "Claude",
							options: [
								{
									id: "opus-1m",
									provider: "claude",
									label: "Opus 4.7 1M",
									cliModel: "opus-1m",
									effortLevels: ["low", "medium", "high", "max"],
									supportsFastMode: true,
								},
							],
						},
					],
					list_workspace_groups: () => [
						{
							id: "in-progress",
							label: "In Progress",
							tone: "progress",
							rows: [
								{
									id: "workspace-ime",
									title: "IME workspace",
									directoryName: "ime-workspace",
									repoName: "helmor",
									state: "ready",
									hasUnread: false,
									workspaceUnread: 0,
									sessionUnreadTotal: 0,
									unreadSessionCount: 0,
									derivedStatus: "in-progress",
									manualStatus: null,
									branch: "ime-fix",
									activeSessionId: "session-ime",
									activeSessionTitle: "IME session",
									activeSessionAgentType: "codex",
									activeSessionStatus: "idle",
									sessionCount: 1,
									messageCount: 0,
								},
							],
						},
					],
					list_archived_workspaces: () => [],
					get_workspace: () => ({
						id: "workspace-ime",
						title: "IME workspace",
						repoId: "repo-ime",
						repoName: "helmor",
						repoIconSrc: null,
						repoInitials: "H",
						remote: "origin",
						remoteUrl: "git@github.com:example/helmor.git",
						defaultBranch: "main",
						rootPath: "/tmp/ime-workspace",
						directoryName: "ime-workspace",
						state: "ready",
						hasUnread: false,
						workspaceUnread: 0,
						sessionUnreadTotal: 0,
						unreadSessionCount: 0,
						derivedStatus: "in-progress",
						manualStatus: null,
						activeSessionId: "session-ime",
						activeSessionTitle: "IME session",
						activeSessionAgentType: "codex",
						activeSessionStatus: "idle",
						branch: "ime-fix",
						initializationParentBranch: "main",
						intendedTargetBranch: "main",
						pinnedAt: null,
						prTitle: null,
						archiveCommit: null,
						sessionCount: 1,
						messageCount: 0,
					}),
					list_workspace_sessions: () => [
						{
							id: "session-ime",
							workspaceId: "workspace-ime",
							title: "IME session",
							agentType: "codex",
							status: "idle",
							model: "opus-1m",
							permissionMode: "acceptEdits",
							providerSessionId: null,
							effortLevel: "high",
							unreadCount: 0,
							fastMode: false,
							createdAt: "2026-04-21T00:00:00.000Z",
							updatedAt: "2026-04-21T00:00:00.000Z",
							lastUserMessageAt: null,
							isHidden: false,
							actionKind: null,
							active: true,
						},
					],
					list_session_thread_messages: () => [],
					get_app_update_status: () => ({ status: "idle" }),
					update_app_settings: () => null,
					trigger_workspace_fetch: () => null,
					prewarm_slash_commands_for_workspace: () => null,
					load_repo_scripts: () => null,
					list_workspace_linked_directories: () => [],
					list_workspace_candidate_directories: () => [],
					get_auto_close_action_kinds: () => [],
					get_auto_close_opt_in_asked: () => false,
				},
			};
		});

		await page.goto("/");
		const editor = page.getByLabel("Workspace input");
		await expect(editor).toBeVisible();
		await editor.click();

		const snapshot = await page.evaluate(async () => {
			const editor = document.querySelector(
				'[aria-label="Workspace input"]',
			) as HTMLElement | null;
			if (!editor) throw new Error("Workspace input not found");
			const paragraph = editor.querySelector("p");
			if (!paragraph) throw new Error("Composer paragraph not found");
			const getLexicalEditor = () => {
				const key = Object.keys(editor).find((entry) =>
					entry.startsWith("__lexicalEditor"),
				);
				if (!key) throw new Error("Lexical editor instance not found");
				return (editor as Record<string, unknown>)[key] as {
					update: (fn: () => void) => void;
				};
			};

			const combinedText = "思考大勇分sl dkjf";
			editor.focus();
			editor.dispatchEvent(
				new CompositionEvent("compositionstart", {
					data: "",
					bubbles: true,
					cancelable: true,
				}),
			);
			paragraph.textContent = combinedText;
			const textNode = paragraph.firstChild;
			const sel = window.getSelection();
			if (textNode && sel) {
				const range = document.createRange();
				range.setStart(textNode, combinedText.length);
				range.setEnd(textNode, combinedText.length);
				sel.removeAllRanges();
				sel.addRange(range);
			}
			editor.dispatchEvent(
				new CompositionEvent("compositionupdate", {
					data: "sl dkjf",
					bubbles: true,
					cancelable: true,
				}),
			);
			editor.dispatchEvent(
				new CompositionEvent("compositionend", {
					data: "sl dkjf",
					bubbles: true,
					cancelable: true,
				}),
			);

			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			getLexicalEditor().update(() => {});
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => resolve());
				});
			});

			return {
				text: editor.textContent ?? "",
				paragraphCount: editor.querySelectorAll("p").length,
				html: paragraph.innerHTML,
			};
		});

		expect(snapshot.text).toBe("思考大勇分sldkjf");
		expect(snapshot.text.includes("\u00A0")).toBe(false);
		expect(snapshot.paragraphCount).toBe(1);
	});
});
