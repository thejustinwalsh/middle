/**
 * A copyable command chip — the guaranteed-portable attach fallback ("the
 * copy-command path always works"). Renders the raw command as selectable
 * monospace text with a Copy button; the text is present in the DOM regardless
 * of clipboard support, so it's always copy-paste-accurate by hand.
 */
import { useEffect, useRef, useState } from "react";

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Cancel the "copied" reset timer on unmount so it never fires (and calls
  // setState) after the chip is gone.
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      // Re-copying before the previous reset fires must not leave two timers racing.
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API unavailable (insecure context) — the visible <code> is the
      // fallback the operator selects and copies manually.
    }
  }

  return (
    <span className="copy-command">
      {label ? <span className="copy-label">{label}</span> : null}
      <code>{command}</code>
      <button type="button" onClick={copy} aria-label={`copy: ${command}`}>
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
