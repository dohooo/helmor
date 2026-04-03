import { memo, useMemo, type CSSProperties, type HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type ShimmerTextProps = HTMLAttributes<HTMLSpanElement> & {
  asChild?: false;
  durationMs?: number;
};

export const ShimmerText = memo(function ShimmerText({
  className,
  children,
  durationMs = 1900,
  style,
  ...props
}: ShimmerTextProps) {
  const shimmerStyle = useMemo<CSSProperties>(() => {
    const phaseOffset = Date.now() % durationMs;
    return {
      animationDelay: `${-phaseOffset}ms`,
      animationDuration: `${durationMs}ms`,
      ...style,
    };
  }, [durationMs, style]);

  return (
    <span
      className={cn(
        "helmor-shimmer-text inline-flex items-center whitespace-nowrap",
        className,
      )}
      style={shimmerStyle}
      {...props}
    >
      {children}
    </span>
  );
});
