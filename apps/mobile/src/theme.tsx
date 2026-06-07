import { createContext, type ReactNode, use, useMemo } from "react";
import { useColorScheme } from "react-native";

export type HelmorThemeMode = "light" | "dark";

type HelmorColors = {
	bg: string;
	surface: string;
	elevated: string;
	overlaySurface: string;
	border: string;
	borderSubtle: string;
	text: string;
	textMuted: string;
	textSubtle: string;
	accent: string;
	accentText: string;
	accentMuted: string;
	accentMutedText: string;
	success: string;
	danger: string;
	cameraBackground: string;
	backdrop: string;
};

export type HelmorTheme = {
	mode: HelmorThemeMode;
	colors: HelmorColors;
	radii: typeof radii;
	spacing: typeof spacing;
	text: typeof text;
};

const radii = {
	sm: 8,
	md: 10,
	lg: 14,
	xl: 20,
} as const;

const spacing = {
	xs: 6,
	sm: 10,
	md: 14,
	lg: 20,
	xl: 28,
} as const;

const text = {
	micro: 10,
	mini: 11,
	small: 12,
	ui: 13,
	body: 14,
	title: 15,
	heading: 18,
} as const;

export const lightTheme: HelmorTheme = {
	mode: "light",
	colors: {
		bg: "#ffffff",
		surface: "#fafafa",
		elevated: "#f4f4f5",
		overlaySurface: "#ffffff",
		border: "#e4e4e7",
		borderSubtle: "#f0f0f1",
		text: "#18181b",
		textMuted: "#71717a",
		textSubtle: "#a1a1aa",
		accent: "#27272a",
		accentText: "#fafafa",
		accentMuted: "#f4f4f5",
		accentMutedText: "#27272a",
		success: "#238636",
		danger: "#dc2626",
		cameraBackground: "#050505",
		backdrop: "rgba(0, 0, 0, 0.48)",
	},
	radii,
	spacing,
	text,
};

export const darkTheme: HelmorTheme = {
	mode: "dark",
	colors: {
		bg: "#0f0f0f",
		surface: "#161616",
		elevated: "#1d1d1d",
		overlaySurface: "#161616",
		border: "rgba(255, 255, 255, 0.10)",
		borderSubtle: "rgba(255, 255, 255, 0.06)",
		text: "#fafafa",
		textMuted: "#a1a1aa",
		textSubtle: "#71717a",
		accent: "#e4e4e7",
		accentText: "#27272a",
		accentMuted: "#3f3f46",
		accentMutedText: "#fafafa",
		success: "#7dd3a8",
		danger: "#fb7185",
		cameraBackground: "#050505",
		backdrop: "rgba(0, 0, 0, 0.68)",
	},
	radii,
	spacing,
	text,
};

const ThemeContext = createContext<HelmorTheme>(darkTheme);

export function HelmorThemeProvider({ children }: { children: ReactNode }) {
	const colorScheme = useColorScheme();
	const theme = useMemo(
		() => (colorScheme === "light" ? lightTheme : darkTheme),
		[colorScheme],
	);

	return (
		<ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
	);
}

export function useHelmorTheme(): HelmorTheme {
	return use(ThemeContext);
}
