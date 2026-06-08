// src/shell/panes/error-boundary.tsx
import { Component, type ReactNode } from "react";

interface State {
	error: Error | null;
}

export class PaneErrorBoundary extends Component<
	{ children: ReactNode },
	State
> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error): void {
		// Routes into the existing console.error -> tracing::error! bridge.
		console.error("[pane] error caught by PaneErrorBoundary", error);
	}

	private reset = (): void => {
		this.setState({ error: null });
	};

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
					<p className="text-app-foreground/80">This pane crashed.</p>
					<button
						type="button"
						onClick={this.reset}
						className="cursor-pointer rounded-md border border-app-border px-3 py-1.5 text-app-foreground hover:bg-app-elevated"
					>
						Reload pane
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
