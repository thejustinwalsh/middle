/**
 * Live end-to-end verification for the Copilot adapter against the real `copilot`
 * binary. NOT part of `bun test` — it needs the installed `copilot` CLI (1.0.54+),
 * a `gh`-authenticated session, `tmux`, and network, so it's a manual/CI-gated
 * probe. (This is the mechanical proof for the Epic's live-dispatch criterion that
 * the Codex phase could not run — its sandbox had no `codex` binary; here the
 * `copilot` binary is present.)
 *
 * It exercises the **real adapter code** — `copilotAdapter.installHooks`,
 * `buildLaunchCommand`, `enterAutoMode`, and `resolveTranscriptPath` — end to end,
 * driving the **real dispatcher launch order** for a `startsSessionOnFirstPrompt`
 * adapter:
 *   1. installHooks writes `.copilot/hooks/middle.json` + `config.json` + `hook.sh`
 *      + the gate into a fresh worktree (no auth file — copilot auths via gh).
 *   2. A local HTTP receiver stands in for the dispatcher, recording every
 *      `POST /hooks/:event` (the NORMALIZED events) and allowing `/gates/pr-ready`.
 *   3. buildLaunchCommand's argv+env (incl. `COPILOT_HOME`) launch interactive
 *      copilot in tmux.
 *   4. PROMPT-FIRST ordering (mirrors `implementation.ts` launch→drive): await
 *      `enterAutoMode` (returns on composer-ready), THEN send the prompt, THEN
 *      await `session.started`. Copilot fires no sessionStart until the prompt
 *      arrives, so this order is what makes a live dispatch work.
 *   5. Assert the heartbeat arrived: `session.started`, `turn.started`, `tool.pre`,
 *      `tool.post`, AND `agent.stopped` (Copilot's `sessionEnd`, triggered by
 *      sending `/exit`) — AND that `session.started` arrived only AFTER the prompt
 *      (prompt-triggered), AND that `resolveTranscriptPath(startPayload)` points at
 *      a real `events.jsonl`, AND `enterAutoMode` returned promptly.
 *
 * Run: `bun run packages/adapters/copilot/scripts/verify-live-hooks.ts`
 * Exits 0 on PASS, 1 on FAIL.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copilotAdapter } from "../src/index.ts";

const ROOT = join(homedir(), ".cache", "copilot-live-verify");
const WORKTREE = join(ROOT, "worktree");
const SESSION = "middle-copilot-verify";

type Received = { event: string; at: number; payload: Record<string, unknown> };

/**
 * Run a subprocess and fail fast on a non-zero exit. A missing `tmux`/`copilot`, a
 * failed git commit, or a rejected `send-keys` otherwise degrades into a confusing
 * downstream invariant failure instead of a clear setup error. `allowFailure` is
 * for commands whose failure is expected and benign (e.g. `tmux kill-session` when
 * no such session exists yet); `env` is merged onto the inherited environment.
 */
async function sh(
  args: string[],
  opts: { env?: Record<string, string>; allowFailure?: boolean } = {},
): Promise<void> {
  const proc = Bun.spawn(args, {
    stdout: "ignore",
    stderr: "inherit",
    env: { ...process.env, ...opts.env },
  });
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(`command failed (exit ${code}): ${args.join(" ")}`);
  }
}

async function main(): Promise<void> {
  // Fresh git worktree (copilot keys session state on the git root).
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WORKTREE, { recursive: true });
  writeFileSync(join(WORKTREE, "README.md"), "# copilot live-verify\n");
  await sh(["git", "-C", WORKTREE, "init", "-q"]);
  await sh(["git", "-C", WORKTREE, "add", "-A"]);
  // Git identity via the child-process env (repo convention), not `git -c user.*`.
  await sh(["git", "-C", WORKTREE, "commit", "-qm", "init"], {
    env: {
      GIT_AUTHOR_NAME: "verify",
      GIT_AUTHOR_EMAIL: "verify@example.com",
      GIT_COMMITTER_NAME: "verify",
      GIT_COMMITTER_EMAIL: "verify@example.com",
    },
  });

  // 1. Real adapter installs hooks/config into the worktree.
  await copilotAdapter.installHooks({
    worktree: WORKTREE,
    hookScriptPath: ".middle/hooks/hook.sh",
    dispatcherUrl: "PLACEHOLDER", // overwritten by envOverrides below
    sessionName: SESSION,
    sessionToken: "verify-token",
    epicRef: "124",
  });

  // 2. Local dispatcher stand-in.
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/hooks/")) {
        const event = url.pathname.slice("/hooks/".length);
        let payload: Record<string, unknown> = {};
        try {
          payload = (await req.json()) as Record<string, unknown>;
        } catch {
          /* empty body tolerated */
        }
        received.push({ event, at: Date.now(), payload });
        return new Response("ok");
      }
      if (url.pathname === "/gates/pr-ready") return new Response("ok"); // 200 = allow
      return new Response("not found", { status: 404 });
    },
  });
  const dispatcherUrl = `http://127.0.0.1:${server.port}`;

  // 3. Real adapter builds the launch command; tmux runs it.
  const { argv, env } = copilotAdapter.buildLaunchCommand({
    worktree: WORKTREE,
    sessionName: SESSION,
    sessionToken: "verify-token",
    envOverrides: { MIDDLE_DISPATCHER_URL: dispatcherUrl, MIDDLE_EPIC: "124" },
  });
  await sh(["tmux", "kill-session", "-t", SESSION], { allowFailure: true }); // no prior session yet
  const newSessionArgs = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    WORKTREE,
  ];
  for (const [k, v] of Object.entries(env)) newSessionArgs.push("-e", `${k}=${v}`);
  newSessionArgs.push(...argv);
  await sh(newSessionArgs);

  // 4. Drive in the real dispatcher order for a startsSessionOnFirstPrompt adapter.
  if (copilotAdapter.startsSessionOnFirstPrompt !== true) {
    console.error("FAIL: copilotAdapter.startsSessionOnFirstPrompt is not true");
    process.exit(1);
  }
  const enterStart = Date.now();
  await copilotAdapter.enterAutoMode({ sessionName: SESSION });
  const enterMs = Date.now() - enterStart;
  console.log(`enterAutoMode returned in ${enterMs}ms (composer-ready)`);

  // Send the prompt, then Enter — split like the dispatcher's sendText/sendEnter.
  await sh([
    "tmux",
    "send-keys",
    "-t",
    SESSION,
    "-l",
    "Run exactly this one shell command and nothing else: echo copilot-live-ok",
  ]);
  await Bun.sleep(600);
  // Stamp the submission moment BEFORE the Enter keystroke: a genuinely
  // prompt-triggered session.started fires only after submission, so it must
  // carry `at >= promptSentAt`. Recording after the keystroke would race a
  // fast hook firing between the keystroke and the stamp.
  const promptSentAt = Date.now();
  await sh(["tmux", "send-keys", "-t", SESSION, "Enter"]);

  // Wait for session.started (proves the hook fired post-prompt).
  const startDeadline = Date.now() + 90_000;
  while (Date.now() < startDeadline && !received.some((r) => r.event === "session.started")) {
    await Bun.sleep(500);
  }
  // Wait for the tool round-trip (the bash echo).
  const toolDeadline = Date.now() + 90_000;
  while (Date.now() < toolDeadline && !received.some((r) => r.event === "tool.post")) {
    await Bun.sleep(500);
  }
  await Bun.sleep(3000); // let the turn settle

  // Trigger the turn boundary: copilot has no per-turn stop, so /exit fires
  // sessionEnd → agent.stopped (the mapping under test). These keystrokes tear
  // the session down, so tolerate failure — the agent may have already exited /
  // crashed, and a throw here would abort before the invariant report below.
  await sh(["tmux", "send-keys", "-t", SESSION, "-l", "/exit"], { allowFailure: true });
  await Bun.sleep(300);
  await sh(["tmux", "send-keys", "-t", SESSION, "Enter"], { allowFailure: true });
  const stopDeadline = Date.now() + 30_000;
  while (Date.now() < stopDeadline && !received.some((r) => r.event === "agent.stopped")) {
    await Bun.sleep(500);
  }

  await sh(["tmux", "kill-session", "-t", SESSION], { allowFailure: true }); // /exit may have ended it
  await Bun.sleep(1000);

  // 5. Assert the heartbeat AND the prompt-first / transcript invariants.
  const events = received.map((r) => r.event);
  const want = ["session.started", "turn.started", "tool.pre", "tool.post", "agent.stopped"];
  const missing = want.filter((w) => !events.includes(w));
  const sessionStart = received.find((r) => r.event === "session.started");
  let transcriptOk = false;
  let derivedPath = "<none>";
  if (sessionStart) {
    try {
      derivedPath = copilotAdapter.resolveTranscriptPath(sessionStart.payload);
      transcriptOk = existsSync(derivedPath);
    } catch (err) {
      derivedPath = `<resolve threw: ${(err as Error).message}>`;
    }
  }
  const enterReturnedPromptly = enterMs < 60_000;
  // Prompt-triggered iff session.started arrived (timestamp) at-or-after the
  // prompt was submitted — not merely "hadn't arrived by a pre-send snapshot",
  // which a session.started landing in the send window would slip past.
  const promptTriggered = sessionStart !== undefined && sessionStart.at >= promptSentAt;

  console.log("\n=== received normalized events (in order) ===");
  console.log(events.join("\n") || "(none)");
  console.log("\n=== session.started payload ===");
  console.log(JSON.stringify(sessionStart?.payload ?? {}, null, 2));
  console.log("\n=== invariants ===");
  console.log(`enterAutoMode returned in ${enterMs}ms (promptly: ${enterReturnedPromptly})`);
  console.log(
    `session.started at ${sessionStart?.at ?? "<missing>"} vs prompt sent at ${promptSentAt} ` +
      `(want started >= sent: ${promptTriggered})`,
  );
  console.log(`prompt sent at +${promptSentAt - enterStart}ms from enterAutoMode start`);
  console.log(`derived transcript path: ${derivedPath} (exists: ${transcriptOk})`);

  const ok = missing.length === 0 && transcriptOk && enterReturnedPromptly && promptTriggered;
  console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
  if (!ok) {
    if (missing.length) console.log(`missing events: ${missing.join(", ")}`);
    if (!transcriptOk) console.log(`derived transcript path does not exist: ${derivedPath}`);
    if (!enterReturnedPromptly) console.log(`enterAutoMode stalled to ${enterMs}ms`);
    if (!promptTriggered)
      console.log("session.started fired BEFORE the prompt (not prompt-triggered)");
    await server.stop(true);
    process.exit(1);
  }
  console.log(
    "all heartbeat events fired through the real adapter (prompt-first order); " +
      "session.started is prompt-triggered, sessionEnd mapped to agent.stopped, " +
      "and resolveTranscriptPath points at a real events.jsonl.",
  );
  await server.stop(true);
}

await main();
