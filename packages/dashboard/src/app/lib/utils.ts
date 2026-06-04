/**
 * Class-name helpers shared by the vendored shadcn primitives in
 * `../components/ui`. `cn` is the canonical shadcn merge: `clsx` resolves
 * conditional/array class inputs, then `tailwind-merge` dedupes conflicting
 * Tailwind utilities so a later `px-4` wins over an earlier `px-2`.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class-name inputs, resolving conflicting Tailwind utilities last-wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
