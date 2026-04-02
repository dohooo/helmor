import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { extractImagePaths, ImagePreviewBadge } from "./image-preview";
import {
  ArrowUp,
  BookOpen,
  Bot,
  BrainCircuit,
  Plus,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";
import type { AgentModelSection } from "@/lib/conductor";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type WorkspaceComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (prompt: string, imagePaths: string[]) => void;
  sending?: boolean;
  selectedModelId: string | null;
  modelSections: AgentModelSection[];
  onSelectModel: (modelId: string) => void;
  sendError?: string | null;
};

type ComposerButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  className?: string;
};

function ComposerButton({
  children,
  className,
  ...props
}: ComposerButtonProps) {
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "flex items-center gap-1.5 rounded-lg text-app-foreground-soft transition-colors hover:text-app-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function WorkspaceComposer({
  value,
  onValueChange,
  onSubmit,
  sending = false,
  selectedModelId,
  modelSections,
  onSelectModel,
  sendError,
}: WorkspaceComposerProps) {
  const selectedModel =
    modelSections
      .flatMap((section) => section.options)
      .find((option) => option.id === selectedModelId) ?? null;
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const hasContent = value.trim().length > 0 || attachedImages.length > 0;
  const sendDisabled = sending || !selectedModel || !hasContent;

  // Intercept value changes to extract image paths
  const handleValueChange = useCallback(
    (newValue: string) => {
      const found = extractImagePaths(newValue);
      if (found.length > 0) {
        let cleaned = newValue;
        for (const p of found) cleaned = cleaned.replace(p, "");
        cleaned = cleaned.replace(/\n{2,}/g, "\n").trim();
        setAttachedImages((prev) => [...new Set([...prev, ...found])]);
        onValueChange(cleaned);
      } else {
        onValueChange(newValue);
      }
    },
    [onValueChange],
  );

  const handleRemoveImage = useCallback((path: string) => {
    setAttachedImages((prev) => prev.filter((p) => p !== path));
  }, []);

  const handleSubmit = useCallback(() => {
    const imageRefs = attachedImages.map((p) => `@${p}`);
    const prompt = [value.trim(), ...imageRefs].filter(Boolean).join("\n");
    onSubmit(prompt, attachedImages);
    setAttachedImages([]);
  }, [value, attachedImages, onSubmit]);

  return (
    <div
      aria-label="Workspace composer"
      className="flex min-h-[132px] flex-col rounded-2xl border border-app-border/40 bg-app-sidebar px-4 pb-3 pt-3 shadow-[0_-4px_24px_rgba(0,0,0,0.12),0_0_0_1px_rgba(255,255,255,0.03)]"
    >
      <label htmlFor="workspace-input" className="sr-only">
        Workspace input
      </label>

      {attachedImages.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachedImages.map((p) => (
            <ImagePreviewBadge key={p} path={p} onRemove={() => handleRemoveImage(p)} />
          ))}
        </div>
      ) : null}

      <textarea
        id="workspace-input"
        aria-label="Workspace input"
        value={value}
        onChange={(event) => {
          handleValueChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!sendDisabled) {
              handleSubmit();
            }
          }
        }}
        placeholder="Ask to make changes, @mention files, run /commands"
        className="min-h-[64px] flex-1 resize-none bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-app-foreground outline-none placeholder:text-app-muted"
      />

      {sendError ? (
        <div className="mt-2 rounded-lg border border-app-canceled/30 bg-app-canceled/10 px-3 py-2 text-[12px] text-app-foreground-soft">
          {sendError}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft transition-colors hover:text-app-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong"
            >
              {selectedModel?.provider === "codex" ? (
                <Bot className="size-[14px]" strokeWidth={1.8} />
              ) : (
                <Sparkles className="size-[14px]" strokeWidth={1.8} />
              )}
              <span>{selectedModel?.label ?? "Select model"}</span>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="min-w-[17rem]"
            >
              {modelSections.map((section, index) => (
                <DropdownMenuGroup key={section.id}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>{section.label}</DropdownMenuLabel>
                  {section.options.map((option) => (
                    <DropdownMenuItem
                      key={option.id}
                      onSelect={() => {
                        onSelectModel(option.id);
                      }}
                      className="flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-app-foreground-soft">
                          {option.provider === "claude" ? (
                            <Sparkles className="size-4" strokeWidth={1.9} />
                          ) : (
                            <Bot className="size-4" strokeWidth={1.8} />
                          )}
                        </span>
                        <span className="font-medium">{option.label}</span>
                      </div>

                      {option.badge ? (
                        <span className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
                          {option.badge}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <ComposerButton
            aria-label="Quick command"
            className="justify-center p-1"
            disabled
          >
            <Zap className="size-[15px]" strokeWidth={1.9} />
          </ComposerButton>

          <ComposerButton
            aria-label="Reasoning mode"
            className="gap-1.5 rounded-md bg-app-sidebar-strong px-2.5 py-1 text-[13px] font-medium text-app-foreground-soft hover:text-app-foreground"
            disabled
          >
            <BrainCircuit className="size-[14px]" strokeWidth={1.8} />
            <span>Thinking</span>
          </ComposerButton>

          <ComposerButton
            aria-label="References"
            className="justify-center p-1"
            disabled
          >
            <BookOpen className="size-[15px]" strokeWidth={1.8} />
          </ComposerButton>
        </div>

        <div className="flex items-center gap-1">
          <ComposerButton
            aria-label="Add attachment"
            className="justify-center p-1"
            disabled
          >
            <Plus className="size-4" strokeWidth={1.8} />
          </ComposerButton>

          <button
            type="button"
            aria-label="Send"
            onClick={handleSubmit}
            disabled={sendDisabled}
            className={cn(
              "flex size-8 items-center justify-center rounded-[9px] border border-app-border-strong bg-app-sidebar-strong text-app-foreground transition-transform focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong",
              sendDisabled
                ? "cursor-not-allowed opacity-50"
                : "hover:-translate-y-px",
            )}
          >
            {sending ? (
              <Square className="size-3 fill-current" strokeWidth={0} />
            ) : (
              <ArrowUp className="size-[15px]" strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
