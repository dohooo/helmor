import { useEffect, useRef, useState } from "react";

import { FileIcon } from "./file-icon";

interface Props {
	kind: "file" | "folder";
	onSubmit: (name: string) => void;
	onCancel: () => void;
}

export function InlineCreateRow({ kind, onSubmit, onCancel }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState("");

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	function commit() {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			onCancel();
			return;
		}
		onSubmit(trimmed);
	}

	return (
		<div
			className="flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-[12.5px]"
			style={{ paddingLeft: 6 }}
		>
			<span className="size-3 shrink-0" />
			{kind === "file" ? (
				<FileIcon name={value || "new"} kind="file" />
			) : (
				<span className="size-3.5 shrink-0" />
			)}
			<input
				ref={inputRef}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				onBlur={() => {
					// Mirror VS Code: blur commits if non-empty, cancels otherwise.
					commit();
				}}
				placeholder={kind === "file" ? "filename.ext" : "folder-name"}
				className="h-5 flex-1 rounded-sm border border-border bg-background px-1 text-[12.5px] outline-none focus:border-primary"
			/>
		</div>
	);
}
