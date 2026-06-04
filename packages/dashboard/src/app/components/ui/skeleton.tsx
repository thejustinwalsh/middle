/**
 * shadcn/ui Skeleton — an animated placeholder block. Vendored source. Used by
 * #223 for repo-expansion / Queue / Activity loading states.
 */
import type * as React from "react";
import { cn } from "../../lib/utils.ts";

/** A pulsing placeholder; size it with width/height utilities via `className`. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
