import * as LabelPrimitive from "@radix-ui/react-label";
import type * as React from "react";

import { useLocalizedNode } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function Label({
	className,
	children,
	...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
	const localizedChildren = useLocalizedNode(children);
	return (
		<LabelPrimitive.Root
			data-slot="label"
			className={cn(
				"flex cursor-interactive items-center gap-2 text-body leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{localizedChildren}
		</LabelPrimitive.Root>
	);
}

export { Label };
