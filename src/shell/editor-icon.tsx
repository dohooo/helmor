import { ExternalLink } from "lucide-react";

export function EditorIcon({
	editorId,
	className,
}: {
	editorId: string;
	className?: string;
}) {
	switch (editorId) {
		case "cursor":
			return (
				<svg
					className={className}
					viewBox="0 0 466.73 532.09"
					fill="currentColor"
				>
					<path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
				</svg>
			);
		case "vscode":
		case "vscode-insiders":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M17.58 2.39L10 9.43 4.64 5.42 2 6.76v10.48l2.64 1.34L10 14.57l7.58 7.04L22 19.33V4.67l-4.42-2.28zM4.64 15.36V8.64L7.93 12l-3.29 3.36zM17.58 17.6l-5.37-5.6 5.37-5.6v11.2z" />
				</svg>
			);
		case "windsurf":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M22.6522 4.79395L12.5765 19.206L2.50098 4.79395H10.5387L12.5765 7.93835L14.6143 4.79395H22.6522Z" />
				</svg>
			);
		case "zed":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M5.976 4.016L15.584 4.016L5.648 16H10.496L12.08 13.664L18.688 4.016L20 4.016V20H5.976V17.6H15.584L5.648 4.016H5.976ZM12.08 13.664L10.496 16H20V20H5.976L15.912 8H11.064L9.48 10.336L2.872 20H1.56V4.016H15.584L5.648 16H10.496" />
				</svg>
			);
		case "webstorm":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M0 0v24h24V0H0zm2.4 2.4h19.2v19.2H2.4V2.4zm1.8 1.5v1.2h6v-1.2h-6zm8.7 0L9.6 12.6l-1.8-5.4H6l3 9h1.5l1.5-4.5 1.5 4.5H15l3-9h-1.8l-1.8 5.4-1.5-8.7h-1.5zM4.2 19.2h7.2v1.2H4.2v-1.2z" />
				</svg>
			);
		case "sublime":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M20.953 6.924c-.123-.429-.404-.715-.834-.858-.378-.126-6.32-2.048-6.32-2.048s-.065-.024-.203-.065c-.484-.138-.793-.065-1.136.199-.243.188-8.39 6.1-8.39 6.1S3.535 10.579 3.2 10.877c-.233.208-.374.463-.373.794.002.33.087.523.393.754l8.04 5.078s5.833 1.953 6.243 2.086c.488.16.867.09 1.2-.166.236-.183.347-.273.347-.273l-.003-5.402-7.473-4.424 7.476-2.4" />
				</svg>
			);
		case "terminal":
			return (
				<svg
					className={className}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="4 17 10 11 4 5" />
					<line x1="12" y1="19" x2="20" y2="19" />
				</svg>
			);
		case "warp":
			return (
				<svg className={className} viewBox="0 0 24 24" fill="currentColor">
					<path d="M12.035 2.723h9.253A2.712 2.712 0 0 1 24 5.435v10.529a2.712 2.712 0 0 1-2.712 2.713H8.047Zm-1.681 2.6L6.766 19.677h5.598l-.399 1.6H2.712A2.712 2.712 0 0 1 0 18.565V8.036a2.712 2.712 0 0 1 2.712-2.712Z" />
				</svg>
			);
		default:
			return <ExternalLink className={className} strokeWidth={1.8} />;
	}
}
