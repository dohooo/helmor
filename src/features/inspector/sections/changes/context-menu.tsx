import { CopyIcon, FolderOpenIcon, LinkIcon } from "lucide-react";
import type React from "react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { revealPathInFinder } from "@/lib/api";
import { buildRemoteFileUrl } from "@/lib/remote-file-url";
import type { ChangeRow } from "./types";

export function FileRowContextMenu({
	file,
	workspaceBranch,
	workspaceRemoteUrl,
	children,
}: {
	file: ChangeRow;
	workspaceBranch: string | null;
	workspaceRemoteUrl: string | null;
	children: React.ReactNode;
}) {
	const remoteFileUrl = useMemo(
		() => buildRemoteFileUrl(workspaceRemoteUrl, workspaceBranch, file.path),
		[file.path, workspaceBranch, workspaceRemoteUrl],
	);

	const handleReveal = useCallback(async () => {
		try {
			await revealPathInFinder(file.absolutePath);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to reveal in Finder";
			toast.error(message);
		}
	}, [file.absolutePath]);

	const handleCopyAbsolute = useCallback(
		() => copyToClipboard(file.absolutePath, "Path"),
		[file.absolutePath],
	);
	const handleCopyRelative = useCallback(
		() => copyToClipboard(file.path, "Relative path"),
		[file.path],
	);
	const handleCopyRemoteUrl = useCallback(() => {
		if (!remoteFileUrl) return;
		void copyToClipboard(remoteFileUrl, "Remote file URL");
	}, [remoteFileUrl]);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className="min-w-52">
				<ContextMenuItem onClick={() => void handleReveal()}>
					<FolderOpenIcon />
					<span>Reveal in Finder</span>
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={handleCopyAbsolute}>
					<CopyIcon />
					<span>Copy Path</span>
				</ContextMenuItem>
				<ContextMenuItem onClick={handleCopyRelative}>
					<CopyIcon />
					<span>Copy Relative Path</span>
				</ContextMenuItem>
				<ContextMenuItem
					onClick={handleCopyRemoteUrl}
					disabled={!remoteFileUrl}
				>
					<LinkIcon />
					<span>Copy Remote File URL</span>
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

async function copyToClipboard(value: string, label: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(`${label} copied`, { description: value, duration: 2000 });
	} catch {
		toast.error(`Failed to copy ${label.toLowerCase()}`);
	}
}
