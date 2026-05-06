import type { ContextCard } from "@/lib/sources/types";

/**
 * Mock fixture point. Real data wiring lands in a follow-up: the inbox
 * will run a Tauri command per source (e.g. `list_user_inbox_items`)
 * that fans out across `useForgeAccountsAll()` logins and runs the
 * appropriate GraphQL queries via the existing `forge::github::api`
 * primitives. Until then the inbox renders its real empty / connect
 * states off this list being empty.
 */
export const inboxMockCards: ContextCard[] = [];
