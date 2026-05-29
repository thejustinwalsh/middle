/**
 * Live end-to-end verification for the Codex adapter against the real `codex`
 * binary. NOT part of `bun test` — it needs the installed `codex` CLI, a
 * signed-in `CODEX_HOME`, `tmux`, and network, so it's a manual/CI-gated probe.
 *
 * It exercises the **real adapter code** — `codexAdapter.installHooks`,
 * `buildLaunchCommand`, and `enterAutoMode` — end to end:
 *   1. installHooks writes `.codex/config.toml` + `hook.sh` + the gate + the
 *      auth symlink into a fresh worktree.
 *   2. A local HTTP receiver stands in for the dispatcher, recording every
 *      `POST /hooks/:event` (the normalized events) and allowing the
 *      `/gates/pr-ready` gate (200).
 *   3. buildLaunchCommand's argv+env (incl. `CODEX_HOME`) launch interactive
 *      codex in tmux; enterAutoMode answers the trust dialog(s).
 *   4. A prompt makes the agent run one shell command, then stop.
 *   5. We assert the heartbeat arrived: `session.started` (carrying
 *      `transcript_path`), `turn.started`, `tool.pre`, `tool.post`,
 *      `agent.stopped`.
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
    epicNumber: 177,
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

  // 4. Drive: enterAutoMode answers the trust dialog(s). Fire-and-forget exactly
  //    like the dispatcher (`void dismissPromise`) — do NOT await its full boot
  //    window; send the prompt as soon as SessionStart lands.
  void codexAdapter.enterAutoMode({ sessionName: SESSION }).catch((e: unknown) => {
    console.error(`enterAutoMode error: ${(e as Error).message}`);
  });

  // Wait for SessionStart to land (transcript_path proves the hook fired).
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !received.some((r) => r.event === "session.started")) {
    await Bun.sleep(500);
  }

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

  // Wait for agent.stopped (turn boundary).
  const stopDeadline = Date.now() + 90_000;
  while (Date.now() < stopDeadline && !received.some((r) => r.event === "agent.stopped")) {
    await Bun.sleep(500);
  }

  const finalPane = (await capturePane(SESSION)) ?? "<none>";
  await sh(["tmux", "kill-session", "-t", SESSION]);
  await server.stop(true);

  // 5. Assert the heartbeat.
  const events = received.map((r) => r.event);
  const want = ["session.started", "turn.started", "tool.pre", "tool.post", "agent.stopped"];
  const missing = want.filter((w) => !events.includes(w));
  const sessionStart = received.find((r) => r.event === "session.started");
  const hasTranscriptPath = typeof sessionStart?.payload.transcript_path === "string";

  console.log("=== received normalized events (in order) ===");
  console.log(events.join("\n") || "(none)");
  console.log("\n=== session.started payload ===");
  console.log(JSON.stringify(sessionStart?.payload ?? {}, null, 2));
  console.log("\n=== final pane tail ===");
  console.log(
    finalPane
      .split("\n")
      .filter((l) => l.trim())
      .slice(-8)
      .join("\n"),
  );

  const ok = missing.length === 0 && hasTranscriptPath;
  console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
  if (!ok) {
    if (missing.length) console.log(`missing events: ${missing.join(", ")}`);
    if (!hasTranscriptPath) console.log("session.started carried no transcript_path");
    process.exit(1);
  }
  console.log("all heartbeat events fired through the real adapter; transcript_path present.");
}

await main();
