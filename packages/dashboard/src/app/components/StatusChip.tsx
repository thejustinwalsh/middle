/**
 * StatusChip — the canonical pill for a workflow or adapter state. One tone
 * per state class (active / wait / alarm / idle), all driven from the
 * foundation palette so a future theme swap reskins every chip at once.
 *
 * Variants:
 *  - `active`  → running, dispatched, starting, launching, completed (closed-green)
 *  - `wait`    → waiting-human, rate-limited, parked
 *  - `alarm`   → failed, compensated, cancelled
 *  - `idle`    → idle, unknown, anything not classified
 *
 * The chip is a pure visual — it doesn't navigate or click. Wrap in a `<Button
 * variant="link">` or `<button>` when interactive.
 */
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** Visual tone for a workflow/adapter state pill — one variant per state class. */
export type ChipVariant = "active" | "wait" | "alarm" | "idle";

/** Map a workflow/runner state string to a chip variant. Unknown → idle. */
export function chipVariantForState(state: string): ChipVariant {
  const s = state.toLowerCase();
  if (s === "completed") return "active";
  if (s === "running" || s === "dispatched" || s === "starting" || s === "launching") {
    return "active";
  }
  if (s === "waiting-human" || s === "rate-limited" || s === "parked") return "wait";
  if (s === "failed" || s === "compensated" || s === "cancelled") return "alarm";
  return "idle";
}

const VARIANT_CLASS: Record<ChipVariant, string> = {
  active:
    "border-[color:var(--accent)]/50 bg-[color:var(--accent-soft)] text-[color:var(--accent)]",
  wait: "border-[color:var(--warn)]/50 bg-[color:var(--warn-soft)] text-[color:var(--warn)]",
  alarm: "border-[color:var(--bad)]/50 bg-[color:var(--bad-soft)] text-[color:var(--bad)]",
  idle: "border-[color:var(--border-strong)] bg-[color:var(--panel-2)] text-[color:var(--fg-muted)]",
};

const DOT_CLASS: Record<ChipVariant, string> = {
  active: "bg-[color:var(--accent)]",
  wait: "bg-[color:var(--warn)]",
  alarm: "bg-[color:var(--bad)]",
  idle: "bg-[color:var(--fg-dim)]",
};

export function StatusChip({
  variant,
  children,
  dot = true,
  className,
}: {
  variant: ChipVariant;
  children: ReactNode;
  /** Show the leading state dot. Default true; pass false for textual-only chips. */
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "font-mono text-[11px] leading-[1.4] tabular-nums",
        VARIANT_CLASS[variant],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[variant])}
        />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
