import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initDevReactScan } from "./lib/dev-react-scan";

initDevReactScan();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
