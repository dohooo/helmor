import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register custom font-size tokens (text-nano … text-heading) with
// tailwind-merge so they aren't treated as colors by twMerge's fallback.
const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [
				{
					text: [
						"nano",
						"micro",
						"mini",
						"small",
						"ui",
						"body",
						"title",
						"heading",
					],
				},
			],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
