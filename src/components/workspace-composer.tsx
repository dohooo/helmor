import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  BookOpen,
  Bot,
  BrainCircuit,
  LoaderCircle,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
import type { AgentModelSection } from "../lib/conductor";
import { cn } from "../lib/utils";

type WorkspaceComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
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
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = useMemo(
    () =>
      modelSections
        .flatMap((section) => section.options)
        .find((option) => option.id === selectedModelId) ?? null,
    [modelSections, selectedModelId],
  );
  const sendDisabled = sending || !selectedModel || value.trim().length === 0;

  useEffect(() => {
    if (!isModelMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isModelMenuOpen]);

  return (
    <div
      aria-label="Workspace composer"
      className="flex min-h-[132px] flex-col rounded-[14px] border border-app-border-strong bg-app-sidebar px-4 pb-3 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <label htmlFor="workspace-input" className="sr-only">
        Workspace input
      </label>

      <textarea
        id="workspace-input"
        aria-label="Workspace input"
        value={value}
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!sendDisabled) {
              onSubmit();
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
          <div ref={menuRef} className="relative">
            {isModelMenuOpen ? (
              <div className="absolute bottom-full left-0 z-30 mb-2 min-w-[17rem] overflow-hidden rounded-2xl border border-app-border-strong bg-[#2B2726] shadow-[0_18px_48px_rgba(0,0,0,0.45)]">
                {modelSections.map((section, index) => (
                  <div
                    key={section.id}
                    className={cn(
                      "px-2 py-2",
                      index > 0 ? "border-t border-app-border" : undefined,
                    )}
                  >
                    <div className="px-3 py-2 text-[12px] font-medium text-app-muted">
                      {section.label}
                    </div>

                    <div className="space-y-1">
                      {section.options.map((option) => {
                        const selected = option.id === selectedModelId;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                              onSelectModel(option.id);
                              setIsModelMenuOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-[13px] transition-colors",
                              selected
                                ? "bg-white/[0.06] text-app-foreground"
                                : "text-app-foreground-soft hover:bg-white/[0.04] hover:text-app-foreground",
                            )}
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
                              <span className="rounded-md border border-[#8C6E68] bg-[#5A433E] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[#F4D9D4]">
                                {option.badge}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <ComposerButton
              aria-label="Model selector"
              className="gap-1.5 px-1 py-0.5 text-[13px] font-medium"
              onClick={() => {
                setIsModelMenuOpen((current) => !current);
              }}
            >
              {selectedModel?.provider === "codex" ? (
                <Bot className="size-[14px]" strokeWidth={1.8} />
              ) : (
                <Sparkles className="size-[14px]" strokeWidth={1.8} />
              )}
              <span>{selectedModel?.label ?? "Select model"}</span>
            </ComposerButton>
          </div>

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
            aria-label="Activity"
            className="justify-center p-1"
            disabled
          >
            <LoaderCircle
              className={cn("size-[15px]", sending ? "animate-spin" : undefined)}
              strokeWidth={1.8}
            />
          </ComposerButton>

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
            onClick={onSubmit}
            disabled={sendDisabled}
            className={cn(
              "flex size-8 items-center justify-center rounded-[9px] border border-app-border-strong bg-app-sidebar-strong text-app-foreground transition-transform focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong",
              sendDisabled
                ? "cursor-not-allowed opacity-50"
                : "hover:-translate-y-px",
            )}
          >
            {sending ? (
              <LoaderCircle className="size-[15px] animate-spin" strokeWidth={2.1} />
            ) : (
              <ArrowUp className="size-[15px]" strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

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
