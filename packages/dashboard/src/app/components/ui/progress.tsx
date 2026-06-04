/**
 * shadcn/ui Progress — Radix Progress with a filled indicator. Vendored source.
 * Used for the Epic sub-issue counters (`closed`/`total`).
 */
import type * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../lib/utils.ts";

/** A determinate progress bar; `value` is 0–100. The track + fill carry the theme tokens. */
export function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // Sanitize once: a non-finite (NaN / ±Infinity) or out-of-range value would
  // otherwise produce an invalid/visually-broken translateX *and* trip Radix's
  // own range validation. A finite number clamps to [0, 100]; anything else
  // (null / undefined / NaN / Infinity) is treated as indeterminate — passed to
  // the Radix Root as `undefined` and rendered as an empty (0%) bar.
  const clamped =
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(100, Math.max(0, value))
      : undefined;
  const pct = clamped ?? 0;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      value={clamped}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-success transition-all"
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
