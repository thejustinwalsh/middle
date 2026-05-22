/**
 * The literal text `send-keys` carries into a tmux session to start or continue
 * the agent. `send-keys` cannot cleanly carry a multi-line prompt — embedded
 * newlines submit early — so the full prompt lives on disk and this returns a
 * one-line `@`-reference that force-includes it. A single `@` prefixes the
 * whole relative path.
 */
export function buildPromptText(opts: {
  promptFile: string;
  kind: "initial" | "resume" | "answer";
}): string {
  const ref = `@${opts.promptFile}`;
  switch (opts.kind) {
    case "initial":
      return ref;
    case "resume":
      return `Resuming this workstream — re-read the linked context and continue. ${ref}`;
    case "answer":
      return `A human answered your open question — read the answer and continue. ${ref}`;
  }
}
