"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	type HTMLAttributes,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type BundledLanguage,
	bundledLanguages,
	bundledLanguagesAlias,
	codeToHtml,
} from "shiki";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string;
	language?: string;
	showLineNumbers?: boolean;
};

type CodeBlockContextType = {
	code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({ code: "" });

function resolveLanguage(language?: string): BundledLanguage | null {
	if (!language) return null;
	const lower = language.toLowerCase();
	if (lower in bundledLanguages) {
		return lower as BundledLanguage;
	}
	const alias = (
		bundledLanguagesAlias as unknown as Record<string, string | undefined>
	)[lower];
	if (alias && alias in bundledLanguages) {
		return alias as BundledLanguage;
	}
	return null;
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function plainHtml(code: string) {
	return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

export const CodeBlock = ({
	code,
	language,
	showLineNumbers = false,
	className,
	children,
	...props
}: CodeBlockProps) => {
	const [lightHtml, setLightHtml] = useState(() => plainHtml(code));
	const [darkHtml, setDarkHtml] = useState(() => plainHtml(code));
	const resolvedLanguage = useMemo(() => resolveLanguage(language), [language]);

	useEffect(() => {
		let cancelled = false;

		const render = async () => {
			if (!resolvedLanguage) {
				const html = plainHtml(code);
				if (!cancelled) {
					setLightHtml(html);
					setDarkHtml(html);
				}
				return;
			}

			const lineNumbers =
				showLineNumbers === true
					? [
							{
								name: "line-numbers",
								line(node: { children: unknown[] }, line: number) {
									node.children.unshift({
										type: "element",
										tagName: "span",
										properties: {
											className: [
												"inline-block",
												"min-w-8",
												"mr-4",
												"select-none",
												"text-right",
												"text-muted-foreground/55",
											],
										},
										children: [{ type: "text", value: String(line) }],
									});
								},
							},
						]
					: [];

			const [light, dark] = await Promise.all([
				codeToHtml(code, {
					lang: resolvedLanguage,
					theme: "one-light",
					transformers: lineNumbers,
				}),
				codeToHtml(code, {
					lang: resolvedLanguage,
					theme: "one-dark-pro",
					transformers: lineNumbers,
				}),
			]);

			if (!cancelled) {
				setLightHtml(light);
				setDarkHtml(dark);
			}
		};

		void render();
		return () => {
			cancelled = true;
		};
	}, [code, resolvedLanguage, showLineNumbers]);

	return (
		<CodeBlockContext.Provider value={{ code }}>
			<div
				className={cn(
					"group relative my-4 w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-app-border/70 bg-app-sidebar/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
					className,
				)}
				{...props}
			>
				<div className="flex items-center justify-between gap-2 border-b border-app-border/60 px-3 py-2">
					<span className="truncate font-mono text-[10.5px] tracking-wide text-app-muted uppercase">
						{language || "code"}
					</span>
					<div className="flex items-center gap-1">{children}</div>
				</div>
				<div className="relative">
					<div
						className="overflow-x-auto overflow-y-hidden px-0 py-0 dark:hidden [&>pre]:m-0 [&>pre]:min-w-full [&>pre]:bg-transparent! [&>pre]:p-3.5 [&>pre]:text-[12px] [&>pre]:leading-5 [&>pre]:text-foreground! [&_code]:font-mono [&_code]:text-[12px]"
						dangerouslySetInnerHTML={{ __html: lightHtml }}
					/>
					<div
						className="hidden overflow-x-auto overflow-y-hidden px-0 py-0 dark:block [&>pre]:m-0 [&>pre]:min-w-full [&>pre]:bg-transparent! [&>pre]:p-3.5 [&>pre]:text-[12px] [&>pre]:leading-5 [&>pre]:text-foreground! [&_code]:font-mono [&_code]:text-[12px]"
						dangerouslySetInnerHTML={{ __html: darkHtml }}
					/>
				</div>
			</div>
		</CodeBlockContext.Provider>
	);
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	timeout?: number;
};

export const CodeBlockCopyButton = ({
	timeout = 2000,
	className,
	children,
	...props
}: CodeBlockCopyButtonProps) => {
	const [copied, setCopied] = useState(false);
	const { code } = useContext(CodeBlockContext);

	const copyToClipboard = async () => {
		if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
			return;
		}

		await navigator.clipboard.writeText(code);
		setCopied(true);
		window.setTimeout(() => setCopied(false), timeout);
	};

	const Icon = copied ? CheckIcon : CopyIcon;

	return (
		<Button
			className={cn(
				"h-7 w-7 rounded-md border border-app-border/60 bg-app-base/70 text-app-muted hover:bg-app-toolbar-hover hover:text-app-foreground",
				className,
			)}
			onClick={() => {
				void copyToClipboard();
			}}
			size="icon"
			type="button"
			variant="ghost"
			{...props}
		>
			{children ?? <Icon size={14} />}
		</Button>
	);
};
