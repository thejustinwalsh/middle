/**
 * shadcn/ui Badge — a small `cva`-variant status pill. Vendored source, plus a
 * `success`/`warning` variant for the dashboard's live/parked/rate-limit states.
 */
import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.ts";

/** Tailwind class recipe for the Badge variants. */
export const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-destructive text-destructive",
        success: "border-success text-success",
        warning: "border-warning text-warning",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/** Props for {@link Badge}: native span props + the cva variant. */
export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

/** A status pill; pick a `variant` per the state's intent (success/warning/destructive). */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}
