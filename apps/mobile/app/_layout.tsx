import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { HelmorThemeProvider, useHelmorTheme } from "../src/theme";

export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<HelmorThemeProvider>
				<ThemedStack />
			</HelmorThemeProvider>
		</SafeAreaProvider>
	);
}

function ThemedStack() {
	const theme = useHelmorTheme();

	return (
		<>
			<StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
			<Stack
				screenOptions={{
					contentStyle: { backgroundColor: theme.colors.bg },
					headerShown: false,
				}}
			/>
		</>
	);
}
