/**
 * shadcn/ui Collapsible — Radix Collapsible re-exported with `data-slot`
 * markers. Vendored source. Used for the repo expansions in the Dashboard view.
 */
import type * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

/** The collapsible root — controls open state via `open`/`onOpenChange`. */
export function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/** The trigger that toggles the collapsible (use `asChild` to style a custom element). */
export function CollapsibleTrigger(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>,
) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

/** The region revealed when open. */
export function CollapsibleContent(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>,
) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}
