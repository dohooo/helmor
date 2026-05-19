import { Check, ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	type AppSettings,
	type DarkTheme,
	resolveTheme,
	type ThemeMode,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { FontPicker } from "../components/font-picker";
import { FontSizeStepper } from "../components/font-size-stepper";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

type ColorThemeOption = {
	id: DarkTheme;
	label: string;
	bg: string;
	accent: string;
	lightBg: string;
	lightAccent: string;
};

/// Swatch tints for the Color Theme picker. Two stops per side so each
/// preset reads as a distinct gradient circle — vivid in dark mode,
/// softer in light mode.
const DARK_THEME_OPTIONS: readonly ColorThemeOption[] = [
	{
		id: "default",
		label: "Default",
		bg: "oklch(0.38 0 0)",
		accent: "oklch(0.18 0 0)",
		lightBg: "oklch(0.88 0 0)",
		lightAccent: "oklch(0.52 0 0)",
	},
	{
		id: "midnight",
		label: "Midnight",
		bg: "oklch(0.62 0.14 258)",
		accent: "oklch(0.30 0.10 260)",
		lightBg: "oklch(0.82 0.09 258)",
		lightAccent: "oklch(0.46 0.20 255)",
	},
	{
		id: "forest",
		label: "Forest",
		bg: "oklch(0.58 0.13 150)",
		accent: "oklch(0.28 0.08 155)",
		lightBg: "oklch(0.80 0.09 152)",
		lightAccent: "oklch(0.44 0.17 148)",
	},
	{
		id: "ember",
		label: "Ember",
		bg: "oklch(0.66 0.15 55)",
		accent: "oklch(0.32 0.09 48)",
		lightBg: "oklch(0.84 0.11 60)",
		lightAccent: "oklch(0.52 0.19 50)",
	},
	{
		id: "aurora",
		label: "Aurora",
		bg: "oklch(0.60 0.15 286)",
		accent: "oklch(0.28 0.09 292)",
		lightBg: "oklch(0.80 0.10 289)",
		lightAccent: "oklch(0.46 0.20 284)",
	},
	{
		id: "aubergine",
		label: "Aubergine",
		bg: "oklch(0.46 0.20 295)",
		accent: "oklch(0.22 0.06 320)",
		lightBg: "oklch(0.84 0.06 320)",
		lightAccent: "oklch(0.46 0.20 295)",
	},
	{
		id: "hoth",
		label: "Hoth",
		bg: "oklch(0.55 0.05 230)",
		accent: "oklch(0.25 0.02 230)",
		lightBg: "oklch(0.86 0.02 230)",
		lightAccent: "oklch(0.55 0.13 235)",
	},
	{
		id: "choco-mint",
		label: "Choco Mint",
		bg: "oklch(0.62 0.12 175)",
		accent: "oklch(0.26 0.04 50)",
		lightBg: "oklch(0.84 0.02 65)",
		lightAccent: "oklch(0.50 0.13 175)",
	},
	{
		id: "banana",
		label: "Banana",
		bg: "oklch(0.80 0.13 70)",
		accent: "oklch(0.30 0.06 75)",
		lightBg: "oklch(0.92 0.04 90)",
		lightAccent: "oklch(0.45 0.18 330)",
	},
];

function ThemeSwatch({
	option,
	isLight,
	size = 18,
}: {
	option: ColorThemeOption;
	isLight: boolean;
	size?: number;
}) {
	const bg = isLight ? option.lightBg : option.bg;
	const accent = isLight ? option.lightAccent : option.accent;
	return (
		<span
			aria-hidden="true"
			className="block shrink-0 rounded-full"
			style={{
				width: size,
				height: size,
				background: `linear-gradient(135deg, ${bg}, ${accent})`,
			}}
		/>
	);
}

function ColorThemePicker({
	value,
	isLight,
	onChange,
}: {
	value: DarkTheme;
	isLight: boolean;
	onChange: (next: DarkTheme) => void;
}) {
	const [open, setOpen] = useState(false);
	const current =
		DARK_THEME_OPTIONS.find((o) => o.id === value) ?? DARK_THEME_OPTIONS[0];

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					className="h-8 w-[180px] justify-between gap-2 px-2 text-[13px] font-normal"
				>
					<span className="flex min-w-0 items-center gap-2">
						<ThemeSwatch option={current} isLight={isLight} size={16} />
						<span className="truncate">{current.label}</span>
					</span>
					<ChevronDown
						className="size-3.5 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" sideOffset={4} className="w-[220px] p-1">
				<div role="listbox" className="flex flex-col">
					{DARK_THEME_OPTIONS.map((opt) => {
						const selected = opt.id === value;
						return (
							<button
								key={opt.id}
								type="button"
								role="option"
								aria-selected={selected}
								onClick={() => {
									onChange(opt.id);
									setOpen(false);
								}}
								className={cn(
									"flex h-8 cursor-interactive items-center justify-between gap-2 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-accent",
									selected && "bg-accent/60",
								)}
							>
								<span className="flex min-w-0 items-center gap-2">
									<ThemeSwatch option={opt} isLight={isLight} size={16} />
									<span className="truncate">{opt.label}</span>
								</span>
								{selected ? (
									<Check
										className="size-3.5 shrink-0 text-muted-foreground"
										strokeWidth={2}
									/>
								) : null}
							</button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}

type EffectiveFonts = {
	fontSans: string;
	fontMono: string;
	fontTerminal: string;
};

function sampleEffectiveFonts(): EffectiveFonts {
	if (typeof document === "undefined") {
		return { fontSans: "", fontMono: "", fontTerminal: "" };
	}
	const cs = getComputedStyle(document.documentElement);
	return {
		fontSans: cs.getPropertyValue("--font-sans").trim(),
		fontMono: cs.getPropertyValue("--font-mono").trim(),
		fontTerminal: cs.getPropertyValue("--font-terminal").trim(),
	};
}

export type AppearancePanelProps = {
	settings: AppSettings;
	updateSettings: (patch: Partial<AppSettings>) => void;
};

export function AppearancePanel({
	settings,
	updateSettings,
}: AppearancePanelProps) {
	const isLight = resolveTheme(settings.theme) === "light";

	// Re-sample the live font stacks each time the user changes a
	// font-affecting setting so the placeholders show what's actually
	// rendering. RAF defers one frame to let `useThemeApplication`
	// commit its DOM mutations first.
	const [effective, setEffective] =
		useState<EffectiveFonts>(sampleEffectiveFonts);
	useEffect(() => {
		const id = requestAnimationFrame(() =>
			setEffective(sampleEffectiveFonts()),
		);
		return () => cancelAnimationFrame(id);
	}, [
		settings.uiFontFamily,
		settings.codeFontFamily,
		settings.terminalFontFamily,
	]);

	return (
		<SettingsGroup>
			{/* ── Mode ─────────────────────────────────────────────────────── */}
			<SettingsRow
				title="Theme"
				description="Use light, dark, or match your system"
			>
				<ToggleGroup
					type="single"
					value={settings.theme}
					className="gap-1.5"
					onValueChange={(value: string) => {
						if (value) updateSettings({ theme: value as ThemeMode });
					}}
				>
					{(
						[
							{ value: "light", icon: Sun, label: "Light" },
							{ value: "dark", icon: Moon, label: "Dark" },
							{ value: "system", icon: Monitor, label: "System" },
						] as const
					).map(({ value, icon: Icon, label }) => (
						<ToggleGroupItem
							key={value}
							value={value}
							className="gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
						>
							<Icon className="size-3.5" strokeWidth={1.8} />
							{label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</SettingsRow>

			{/* ── Color theme ──────────────────────────────────────────────── */}
			<SettingsRow title="Color Theme" description="Choose an accent palette">
				<ColorThemePicker
					value={settings.darkTheme}
					isLight={isLight}
					onChange={(next) => updateSettings({ darkTheme: next })}
				/>
			</SettingsRow>

			{/* ── Chat font size ────────────────────────────────────────────── */}
			<SettingsRow
				title="Chat font size"
				description="Size used for chat message bodies"
			>
				<FontSizeStepper
					value={settings.chatFontSize}
					onChange={(next) => updateSettings({ chatFontSize: next })}
					min={12}
					max={24}
					ariaLabel="Chat font size"
				/>
			</SettingsRow>

			{/* ── Fonts (free-form text inputs) ─────────────────────────────── */}
			<SettingsRow title="UI font">
				<FontPicker
					value={settings.uiFontFamily}
					onChange={(next) => updateSettings({ uiFontFamily: next })}
					effectivePlaceholder={effective.fontSans}
					ariaLabel="UI font family"
				/>
			</SettingsRow>

			<SettingsRow title="Code font">
				<FontPicker
					value={settings.codeFontFamily}
					onChange={(next) => updateSettings({ codeFontFamily: next })}
					effectivePlaceholder={effective.fontMono}
					ariaLabel="Code font family"
				/>
			</SettingsRow>

			<SettingsRow title="Terminal font">
				<FontPicker
					value={settings.terminalFontFamily}
					onChange={(next) => updateSettings({ terminalFontFamily: next })}
					effectivePlaceholder={effective.fontTerminal}
					ariaLabel="Terminal font family"
				/>
			</SettingsRow>

			{/* ── Cursors ──────────────────────────────────────────────────── */}
			<SettingsRow
				title="Use pointer cursors"
				description="Change the cursor to a pointer when hovering over interactive elements"
			>
				<Switch
					checked={settings.usePointerCursors}
					onCheckedChange={(checked) =>
						updateSettings({ usePointerCursors: checked })
					}
				/>
			</SettingsRow>
		</SettingsGroup>
	);
}
