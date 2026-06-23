import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { APP_LANGUAGE_OPTIONS, isAppLanguage } from "@/lib/i18n/types";
import { useSettings } from "@/lib/settings";

export function OnboardingLanguageMenu() {
	const { settings, updateSettings } = useSettings();
	const current =
		APP_LANGUAGE_OPTIONS.find((option) => option.value === settings.language) ??
		APP_LANGUAGE_OPTIONS[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-label="language"
					className="h-7 gap-1 rounded-md px-2 text-small font-normal text-muted-foreground hover:text-foreground"
				>
					<span>{current.label}</span>
					<ChevronDown data-icon="inline-end" className="size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-32">
				<DropdownMenuRadioGroup
					value={settings.language}
					onValueChange={(value) => {
						if (!isAppLanguage(value) || value === settings.language) {
							return;
						}
						void updateSettings({ language: value });
					}}
				>
					{APP_LANGUAGE_OPTIONS.map((option) => (
						<DropdownMenuRadioItem key={option.value} value={option.value}>
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
