import "./App.css";
import { resolveE2eScenarioElement } from "./shell/boot/e2e-routes";
import { AppProviders } from "./shell/components/app-providers";
import { AppShell } from "./shell/components/app-shell";
import { useAppBootstrap } from "./shell/hooks/use-app-bootstrap";

function App() {
	const e2eElement = resolveE2eScenarioElement();
	if (e2eElement) return e2eElement;
	return <MainApp />;
}

function MainApp() {
	const bootstrap = useAppBootstrap();
	return <AppProviders {...bootstrap} AppShell={AppShell} />;
}

export default App;
