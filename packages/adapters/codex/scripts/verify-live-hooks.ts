/**
 * Live end-to-end verification for the Codex adapter against the real `codex`
 * binary. NOT part of `bun test` — it needs the installed `codex` CLI, a
 * signed-in `CODEX_HOME`, `tmux`, and network, so it's a manual/CI-gated probe.
 *
 * It exercises the **real adapter code** — `codexAdapter.installHooks`,
 * `buildLaunchCommand`, and `enterAutoMode` — end to end, driving the **real
 * dispatcher launch order** for a `startsSessionOnFirstPrompt` adapter (#183):
 *   1. installHooks writes `.codex/config.toml` + `hook.sh` + the gate + the
 *      auth symlink into a fresh worktree.
 *   2. A local HTTP receiver stands in for the dispatcher, recording every
 *      `POST /hooks/:event` (the normalized events) and allowing the
 *      `/gates/pr-ready` gate (200).
 *   3. buildLaunchCommand's argv+env (incl. `CODEX_HOME`) launch interactive
 *      codex in tmux.
 *   4. PROMPT-FIRST ordering (mirrors `implementation.ts` launch→drive): await
 *      `enterAutoMode` (answers the trust dialog(s), returns on composer-ready),
 *      THEN send the prompt, THEN await `session.started`. codex fires no
 *      SessionStart until the prompt arrives, so this order is what makes a live
 *      dispatch work — the old await-first order would deadlock.
 *   5. We assert the heartbeat arrived: `session.started` (carrying
 *      `transcript_path`), `turn.started`, `tool.pre`, `tool.post`,
 *      `agent.stopped` — AND that `session.started` arrived only AFTER the prompt
 *      was sent (proving the prompt-triggered-session behavior), AND that
 *      `enterAutoMode` returned promptly (composer-ready, not the boot deadline).
 *
 * Run: `bun run packages/adapters/codex/scripts/verify-live-hooks.ts`
 * Exits 0 on PASS, 1 on FAIL.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { capturePane } from "@middle/core";
import { codexAdapter } from "../src/index.ts";

const ROOT = join(homedir(), ".cache", "codex-live-verify");
const WORKTREE = join(ROOT, "worktree");
const SESSION = "middle-codex-verify";

type Received = { event: string; payload: Record<string, unknown> };

async function sh(args: string[]): Promise<void> {
  await Bun.spawn(args, { stdout: "ignore", stderr: "ignore" }).exited;
}

async function main(): Promise<void> {
  // Fresh worktree.
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WORKTREE, { recursive: true });
  writeFileSync(join(WORKTREE, "README.md"), "# codex live-verify\n");

  // 1. Real adapter installs hooks/config/auth into the worktree.
  await codexAdapter.installHooks({
    worktree: WORKTREE,
    hookScriptPath: ".middle/hooks/hook.sh",
    dispatcherUrl: "PLACEHOLDER", // overwritten by envOverrides below
    sessionName: SESSION,
    sessionToken: "verify-token",
    epicRef: "177",
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
        received.push({ event, payload });
        return new Response("ok");
      }
      if (url.pathname === "/gates/pr-ready") return new Response("ok"); // 200 = allow
      return new Response("not found", { status: 404 });
    },
  });
  const dispatcherUrl = `http://127.0.0.1:${server.port}`;

  // 3. Real adapter builds the launch command; tmux runs it (mirrors the
  //    dispatcher's tmux gateway: -e KEY=value env, -c cwd, then argv).
  const { argv, env } = codexAdapter.buildLaunchCommand({
    worktree: WORKTREE,
    sessionName: SESSION,
    sessionToken: "verify-token",
    envOverrides: { MIDDLE_DISPATCHER_URL: dispatcherUrl, MIDDLE_EPIC: "177" },
  });
  await sh(["tmux", "kill-session", "-t", SESSION]);
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

  // 4. Drive in the real dispatcher order for a startsSessionOnFirstPrompt
  //    adapter: AWAIT enterAutoMode (answers the trust dialog(s) and returns on
  //    composer-ready), THEN send the prompt, THEN await session.started. codex
  //    fires no SessionStart until the prompt arrives.
  if (codexAdapter.startsSessionOnFirstPrompt !== true) {
    console.error("FAIL: codexAdapter.startsSessionOnFirstPrompt is not true");
    process.exit(1);
  }
  const enterStart = Date.now();
  await codexAdapter.enterAutoMode({ sessionName: SESSION });
  const enterMs = Date.now() - enterStart;
  console.log(`enterAutoMode returned in ${enterMs}ms (composer-ready)`);

  // No session must exist yet — codex is prompt-triggered.
  const sessionStartedBeforePrompt = received.some((r) => r.event === "session.started");

  // Send the prompt, then Enter — split like the dispatcher's sendText/sendEnter
  // (a combined send can submit before the TUI registers the typed text). `-l`
  // sends the text literally; the Enter is a separate keystroke after a pause.
  await sh([
    "tmux",
    "send-keys",
    "-t",
    SESSION,
    "-l",
    "Run exactly this shell command: echo codex-live-ok",
  ]);
  await Bun.sleep(500);
  await sh(["tmux", "send-keys", "-t", SESSION, "Enter"]);
  const promptSentAt = Date.now();

  // Wait for session.started (transcript_path proves the hook fired) — it should
  // arrive only AFTER the prompt above.
  const startDeadline = Date.now() + 90_000;
  while (Date.now() < startDeadline && !received.some((r) => r.event === "session.started")) {
    await Bun.sleep(500);
  }

  // Wait for agent.stopped (turn boundary).
  const stopDeadline = Date.now() + 90_000;
  while (Date.now() < stopDeadline && !received.some((r) => r.event === "agent.stopped")) {
    await Bun.sleep(500);
  }

  const finalPane = (await capturePane(SESSION)) ?? "<none>";
  await sh(["tmux", "kill-session", "-t", SESSION]);
  await server.stop(true);

  // 5. Assert the heartbeat AND the prompt-first invariants.
  const events = received.map((r) => r.event);
  const want = ["session.started", "turn.started", "tool.pre", "tool.post", "agent.stopped"];
  const missing = want.filter((w) => !events.includes(w));
  const sessionStart = received.find((r) => r.event === "session.started");
  const hasTranscriptPath = typeof sessionStart?.payload.transcript_path === "string";
  // enterAutoMode must return on composer-ready, well before the boot deadline —
  // otherwise prompt-first would stall every launch.
  const enterReturnedPromptly = enterMs < 60_000;
  // session.started must be prompt-triggered: absent before the prompt was sent.
  const promptTriggered = !sessionStartedBeforePrompt;

  console.log("=== received normalized events (in order) ===");
  console.log(events.join("\n") || "(none)");
  console.log("\n=== session.started payload ===");
  console.log(JSON.stringify(sessionStart?.payload ?? {}, null, 2));
  console.log("\n=== prompt-first invariants ===");
  console.log(`enterAutoMode returned in ${enterMs}ms (promptly: ${enterReturnedPromptly})`);
  console.log(`session.started before prompt sent: ${sessionStartedBeforePrompt} (want false)`);
  console.log(`prompt sent at +${promptSentAt - enterStart}ms from enterAutoMode start`);
  console.log("\n=== final pane tail ===");
  console.log(
    finalPane
      .split("\n")
      .filter((l) => l.trim())
      .slice(-8)
      .join("\n"),
  );

  const ok = missing.length === 0 && hasTranscriptPath && enterReturnedPromptly && promptTriggered;
  console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
  if (!ok) {
    if (missing.length) console.log(`missing events: ${missing.join(", ")}`);
    if (!hasTranscriptPath) console.log("session.started carried no transcript_path");
    if (!enterReturnedPromptly) console.log(`enterAutoMode stalled to ${enterMs}ms`);
    if (!promptTriggered)
      console.log("session.started fired BEFORE the prompt (not prompt-triggered)");
    process.exit(1);
  }
  console.log(
    "all heartbeat events fired through the real adapter (prompt-first order); " +
      "session.started is prompt-triggered and carries transcript_path.",
  );
}

await main();
