/**
 * DF-R6-A: toast hygiene for caught errors that may originate from the team
 * companion transport.
 *
 * While the team sandbox sleeps, PASSIVE requests throw a typed
 * `CompanionAsleepError` — the sidebar's gray-cloud staleness indicator
 * already communicates "Sleeping", so surfacing it AGAIN as a red error
 * toast (×N call sites) is pure noise. This helper is the one place that
 * rule lives: silent for typed asleep errors, and same-text dedupe for
 * everything else (a message-stable sonner `id` makes an identical toast
 * REPLACE the visible one instead of stacking).
 */

import { toast } from "sonner";
import { isCompanionAsleepError } from "./companion-asleep";

/**
 * `toast.error` for a caught error: silent when the error is the typed
 * companion-asleep signal; otherwise toasts `message` with a message-derived
 * stable id so same-text toasts never stack. Extra sonner options pass
 * through (an explicit `id` in `options` wins).
 */
export function toastCaughtError(
	error: unknown,
	message: string,
	options?: Parameters<typeof toast.error>[1],
): void {
	if (isCompanionAsleepError(error)) return;
	toast.error(message, { id: `caught-error:${message}`, ...options });
}
