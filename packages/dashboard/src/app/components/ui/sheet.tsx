/**
 * shadcn/ui Sheet — a Radix Dialog rendered as an edge-anchored drawer. Vendored
 * source. The Inspector uses this: anchored `right` on desktop, `bottom` on
 * mobile (#222 swaps `side` by viewport). The `side` prop drives the slide-in
 * edge + the responsive size classes.
 */
import type * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../../lib/utils.ts";

/** The Sheet root — controlled via `open`/`onOpenChange`. */
export const Sheet = SheetPrimitive.Root;
/** Opens the sheet (use `asChild` to wrap a custom trigger). */
export const SheetTrigger = SheetPrimitive.Trigger;
/** Closes the sheet (use `asChild` to wrap a custom control). */
export const SheetClose = SheetPrimitive.Close;
/** Portals the sheet out to the document body. */
export const SheetPortal = SheetPrimitive.Portal;

/** The dimmed backdrop behind the sheet. */
export function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50 bg-black/50", className)}
      {...props}
    />
  );
}

/** Tailwind class recipe for the four sheet anchor edges. */
const sheetVariants = cva("fixed z-50 flex flex-col gap-4 overflow-y-auto bg-card p-4 shadow-lg", {
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b border-border",
      bottom: "inset-x-0 bottom-0 border-t border-border",
      left: "inset-y-0 left-0 h-full w-3/4 border-r border-border sm:max-w-sm",
      right: "inset-y-0 right-0 h-full w-3/4 border-l border-border sm:max-w-md",
    },
  },
  defaultVariants: { side: "right" },
});

/** Props for {@link SheetContent}: dialog content props + the anchor `side`. */
export type SheetContentProps = React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants>;

/** The sheet panel itself, with overlay + a built-in close button. */
export function SheetContent({ side = "right", className, children, ...props }: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

/** A header region for the sheet (title + description). */
export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5", className)} {...props} />
  );
}

/** The sheet's accessible title (required by Radix Dialog for a11y). */
export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
}

/** The sheet's accessible description. */
export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
