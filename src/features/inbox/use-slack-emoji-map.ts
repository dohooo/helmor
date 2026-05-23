import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { slackListEmoji } from "@/lib/api";
import { helmorQueryKeys, PERSIST_META } from "@/lib/query-client";
import { BUILTIN_EMOJI } from "@/lib/slack-emoji-builtin";
import type { SlackEmoji } from "@/lib/slack-text";

/** Custom emojis change rarely; 30 min staleTime keeps Slack happy
 *  without making users wait a full hour for new workspace emoji to
 *  show up in previews after a refresh. */
const STALE_MS = 30 * 60_000;

/** Merged Slack emoji table (built-in unicode + this workspace's custom
 *  emojis). Empty record when no workspace is selected or the fetch
 *  hasn't resolved yet — `renderSlackText` falls back to the muted
 *  `:name:` pill in that case.
 *
 *  Workspace custom emojis OVERRIDE built-in unicode entries — that
 *  matches Slack desktop's precedence rule (if a workspace publishes a
 *  custom `:tada:`, Slack uses that instead of 🎉).
 *
 *  Persisted across cold start. Without this, every cold load of the
 *  Slack inbox shows `:dosu-logo:` etc. as raw text pills for the
 *  first ~500 ms while `emoji.list` round-trips through Slack. The
 *  table is ~200 entries × ~120 bytes (name + URL) ≈ 25 KB — well
 *  under the persister's bounded-size budget. New custom emojis the
 *  workspace publishes between cold starts surface within
 *  `STALE_MS` after the next focus refetch. */
export function useSlackEmojiMap(
	teamId: string | null,
): Record<string, SlackEmoji> {
	const customQuery = useQuery({
		queryKey: teamId
			? helmorQueryKeys.slackEmojiMap(teamId)
			: ["slackEmojiMap", "__none__"],
		enabled: teamId !== null,
		queryFn: async () => {
			if (!teamId) return {};
			return slackListEmoji(teamId);
		},
		staleTime: STALE_MS,
		meta: PERSIST_META,
	});

	return useMemo<Record<string, SlackEmoji>>(() => {
		const merged: Record<string, SlackEmoji> = {};
		for (const [name, char] of Object.entries(BUILTIN_EMOJI)) {
			merged[name] = { kind: "unicode", char };
		}
		const custom = customQuery.data ?? {};
		for (const [name, url] of Object.entries(custom)) {
			merged[name] = { kind: "image", url, name };
		}
		return merged;
	}, [customQuery.data]);
}
