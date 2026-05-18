import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
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

/// Swatch tints for the Color Theme row. Two stops per side so each
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
];

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
				<div className="flex gap-2">
					{DARK_THEME_OPTIONS.map((opt) => {
						const swatchBg = isLight ? opt.lightBg : opt.bg;
						const swatchAccent = isLight ? opt.lightAccent : opt.accent;
						const isSelected = settings.darkTheme === opt.id;
						return (
							<button
								key={opt.id}
								type="button"
								title={opt.label}
								aria-label={opt.label}
								aria-pressed={isSelected}
								className={cn(
									"h-7 w-7 cursor-interactive rounded-full transition-transform duration-150",
									isSelected ? "scale-105" : "hover:scale-105",
								)}
								style={{
									background: `linear-gradient(135deg, ${swatchBg}, ${swatchAccent})`,
									boxShadow: isSelected
										? `0 0 0 2px var(--background), 0 0 0 3.5px ${swatchBg}`
										: undefined,
								}}
								onClick={() => updateSettings({ darkTheme: opt.id })}
							/>
						);
					})}
				</div>
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
