import type { Preview } from "@storybook/react-vite";

// Import the project's global CSS so Tailwind utilities, shadcn tokens,
// and the Helmor color theme are available in every story.
import "../src/App.css";

const preview: Preview = {
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		a11y: {
			test: "todo",
		},
		backgrounds: { disable: true },
	},
	globalTypes: {
		theme: {
			description: "Color theme",
			toolbar: {
				title: "Theme",
				icon: "mirror",
				items: [
					{ value: "light", title: "Light", icon: "sun" },
					{ value: "dark", title: "Dark", icon: "moon" },
					{ value: "side-by-side", title: "Side by Side", icon: "sidebyside" },
				],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: {
		theme: "light",
	},
	decorators: [
		(Story, context) => {
			const theme = context.globals.theme;

			if (theme === "side-by-side") {
				return (
					<div style={{ display: "flex", gap: 0, minHeight: "100%" }}>
						<div
							className="light"
							style={{
								flex: 1,
								padding: "1rem",
								backgroundColor: "var(--background)",
								color: "var(--foreground)",
							}}
						>
							<div
								style={{
									fontSize: 10,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.05em",
									color: "var(--muted-foreground)",
									marginBottom: 8,
								}}
							>
								Light
							</div>
							<Story />
						</div>
						<div
							className="dark"
							style={{
								flex: 1,
								padding: "1rem",
								backgroundColor: "var(--background)",
								color: "var(--foreground)",
							}}
						>
							<div
								style={{
									fontSize: 10,
									fontWeight: 600,
									textTransform: "uppercase",
									letterSpacing: "0.05em",
									color: "var(--muted-foreground)",
									marginBottom: 8,
								}}
							>
								Dark
							</div>
							<Story />
						</div>
					</div>
				);
			}

			const isDark = theme === "dark";
			return (
				<div
					className={isDark ? "dark" : "light"}
					style={{
						padding: "1rem",
						minHeight: "100%",
						backgroundColor: "var(--background)",
						color: "var(--foreground)",
					}}
				>
					<Story />
				</div>
			);
		},
	],
};

export default preview;
