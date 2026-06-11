import "./App.css";
import { QuickShell } from "./features/quick-panel";
import { isQuickPanelWindow } from "./lib/window-role";
import { resolveE2eScenarioElement } from "./shell/boot/e2e-routes";
import { AppProviders } from "./shell/components/app-providers";
import { AppShell } from "./shell/components/app-shell";
import { useAppBootstrap } from "./shell/hooks/use-app-bootstrap";

function App() {
	const e2eElement = resolveE2eScenarioElement();
	if (e2eElement) return e2eElement;
	// Same bundle, two windows: the `quick` window mounts the QuickShell
	// (floating quick-task panel), everything else is the main shell.
	return isQuickPanelWindow ? <QuickApp /> : <MainApp />;
}

function MainApp() {
	const bootstrap = useAppBootstrap();
	return <AppProviders {...bootstrap} AppShell={AppShell} />;
}

function QuickApp() {
	const bootstrap = useAppBootstrap();
	return <AppProviders {...bootstrap} AppShell={QuickShell} />;
}

export default App;
