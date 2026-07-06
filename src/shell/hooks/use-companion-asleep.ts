import { useSyncExternalStore } from "react";
import {
	isCompanionAsleep,
	subscribeCompanionAsleep,
} from "@/lib/companion-asleep";

/**
 * R3-A: reactive "the team sandbox is asleep" signal — set when a PASSIVE
 * request gets the Worker's typed `ContainerAsleep`, cleared by the next
 * successful container answer. Drives the ONE global staleness hint (the
 * sidebar cloud icon); individual queries just keep their previous data.
 */
export function useCompanionAsleep(): boolean {
	return useSyncExternalStore(
		subscribeCompanionAsleep,
		isCompanionAsleep,
		isCompanionAsleep,
	);
}
