import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	type Automation,
	type AutomationStatus,
	type CreateAutomationRequest,
	createAutomation,
	deleteAutomation,
	runAutomationNow,
	setAutomationStatus,
	type UpdateAutomationRequest,
	updateAutomation,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Mutations shared by the list rows, the detail view and the create
 *  dialog. The backend also pushes `automationsChanged` ui-sync events
 *  that invalidate the query globally; we still invalidate locally so
 *  the UI snaps without waiting for the broadcast round-trip. */
export function useAutomationMutations() {
	const queryClient = useQueryClient();

	const invalidate = () => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.automations,
		});
	};

	const replaceInCache = (updated: Automation) => {
		queryClient.setQueryData<Automation[]>(
			helmorQueryKeys.automations,
			(prev) =>
				prev?.map((automation) =>
					automation.id === updated.id ? updated : automation,
				),
		);
	};

	const create = useMutation({
		mutationFn: (request: CreateAutomationRequest) => createAutomation(request),
		onSuccess: invalidate,
		onError: (error) =>
			toast.error("Unable to create automation", {
				description: errorMessage(error),
			}),
	});

	const update = useMutation({
		mutationFn: (request: UpdateAutomationRequest) => updateAutomation(request),
		onSuccess: (updated) => {
			replaceInCache(updated);
			invalidate();
		},
		onError: (error) =>
			toast.error("Unable to update automation", {
				description: errorMessage(error),
			}),
	});

	const remove = useMutation({
		mutationFn: (automationId: string) => deleteAutomation(automationId),
		onSuccess: invalidate,
		onError: (error) =>
			toast.error("Unable to delete automation", {
				description: errorMessage(error),
			}),
	});

	const setStatus = useMutation({
		mutationFn: (input: { automationId: string; status: AutomationStatus }) =>
			setAutomationStatus(input.automationId, input.status),
		onSuccess: (updated) => {
			replaceInCache(updated);
			invalidate();
		},
		onError: (error) =>
			toast.error("Unable to change automation status", {
				description: errorMessage(error),
			}),
	});

	const runNow = useMutation({
		mutationFn: (automationId: string) => runAutomationNow(automationId),
		onSuccess: invalidate,
		onError: (error) =>
			toast.error("Unable to run automation", {
				description: errorMessage(error),
			}),
	});

	return { create, update, remove, setStatus, runNow };
}
