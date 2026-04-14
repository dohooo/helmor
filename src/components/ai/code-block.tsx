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
	wrapLines?: boolean;
	variant?: "default" | "plain";
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
	wrapLines = false,
	variant = "default",
	className,
	children,
	...props
}: CodeBlockProps) => {
	const [lightHtml, setLightHtml] = useState(() => plainHtml(code));
	const [darkHtml, setDarkHtml] = useState(() => plainHtml(code));
	const resolvedLanguage = useMemo(() => resolveLanguage(language), [language]);
	const isPlain = variant === "plain";

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

	const codePadding = isPlain
		? "[&>pre]:p-3.5"
		: "[&>pre]:px-3.5 [&>pre]:pb-3.5 [&>pre]:pt-1";
	const wrapClasses = wrapLines
		? "overflow-x-hidden overflow-y-hidden [&>pre]:whitespace-pre-wrap [&>pre]:break-words [&_code]:whitespace-pre-wrap [&_code]:break-words"
		: "overflow-x-auto overflow-y-hidden [&>pre]:min-w-full";
	const codeBase =
		"[&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:text-[12px] [&>pre]:leading-5 [&>pre]:text-foreground! [&_code]:font-mono [&_code]:text-[12px]";

	return (
		<CodeBlockContext.Provider value={{ code }}>
			<div
				className={cn(
					isPlain
						? "w-full min-w-0 max-w-full"
						: "group relative my-4 w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
					className,
				)}
				{...props}
			>
				{isPlain ? null : (
					<div className="flex items-center justify-between gap-2 px-3 pt-1.5">
						{language ? (
							<span className="truncate font-mono text-[10px] leading-none tracking-wide text-muted-foreground/50 uppercase select-none">
								{language}
							</span>
						) : (
							<span />
						)}
						<div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
							{children}
						</div>
					</div>
				)}
				<div className="relative">
					<div
						className={cn(codeBase, codePadding, wrapClasses, "dark:hidden")}
						dangerouslySetInnerHTML={{ __html: lightHtml }}
					/>
					<div
						className={cn(
							codeBase,
							codePadding,
							wrapClasses,
							"hidden dark:block",
						)}
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
				"h-6 w-6 rounded-md text-muted-foreground/50 hover:bg-accent/60 hover:text-foreground",
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
