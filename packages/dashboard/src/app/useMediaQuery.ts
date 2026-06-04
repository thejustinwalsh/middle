/**
 * Subscribe to a CSS media query and re-render on changes. Used for the layout
 * decisions that must be observable in JS (not just CSS) — e.g. the Inspector
 * Sheet's anchor edge (right on desktop, bottom on mobile). Pure CSS responsive
 * utilities (Tailwind `sm:`/`md:`) handle the rest; this is only for behavior
 * that branches on the breakpoint.
 *
 * SSR/no-`matchMedia` safe: returns `false` until the effect runs in a browser.
 */
import { useEffect, useState } from "react";

/** `true` while `query` matches the viewport; updates on viewport changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
