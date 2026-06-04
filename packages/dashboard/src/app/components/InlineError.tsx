import { Button } from "./ui/button.tsx";

/**
 * An inline error-recovery panel scoped to a single view/section (#223) — not the
 * global error bar. Shows the failure (`message`, or a generic fallback) and, when
 * `onRetry` is given, a Retry button that re-fires the failed request. When
 * `timedOut` is true it shows the distinct "Connection lost — retrying…" state
 * instead of `message` (a >10s network timeout). Rendered with `role="alert"`.
 */
export function InlineError({
  message,
  onRetry,
  timedOut = false,
}: {
  /** The error detail (shown when not a timeout). */
  message?: string;
  /** Re-fire the failed request. */
  onRetry?: () => void;
  /** A >10s network timeout — show the "Connection lost — retrying…" state. */
  timedOut?: boolean;
}) {
  return (
    <div
      role="alert"
      className="inline-error flex flex-col items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
    >
      {timedOut ? (
        <span className="text-warning">Connection lost — retrying…</span>
      ) : (
        <span className="text-destructive">{message ?? "Something went wrong."}</span>
      )}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
