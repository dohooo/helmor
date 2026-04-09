import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createHelmorQueryClient } from "@/lib/query-client";

export function renderWithProviders(
	ui: ReactElement,
	options?: { queryClient?: QueryClient },
) {
	const queryClient = options?.queryClient ?? createHelmorQueryClient();
	queryClient.setDefaultOptions({
		queries: {
			...queryClient.getDefaultOptions().queries,
			retry: false,
		},
	});

	const wrap = (nextUi: ReactElement) => (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={0}>{nextUi}</TooltipProvider>
		</QueryClientProvider>
	);
	const rendered = render(wrap(ui));

	return {
		queryClient,
		...rendered,
		rerender: (nextUi: ReactElement) => {
			rendered.rerender(wrap(nextUi));
		},
	};
}
