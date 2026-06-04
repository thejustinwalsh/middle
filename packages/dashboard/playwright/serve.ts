/**
 * The Playwright test daemon: a real `Bun.serve` of the dashboard SPA + `/api`/
 * `/events` (db-backed via {@link createDbDeps}, on a seeded temp db) plus stubbed
 * `/control/metrics` + `/control/events` (the dispatcher's control plane, which a
 * standalone dashboard server doesn't carry — `mm start` composes both on one
 * port). Launched by `playwright.config.ts`'s `webServer` before the specs run.
 *
 * Seeds exactly what the three smoke flows need: one open Epic (#247) with a
 * running runner (so the Epic card opens the Inspector), and a waiting-human
 * `/control/events` frame (so the Queue table shows a parked row + state badge).
 */
import { createDbDeps } from "../src/db-deps.ts";
import { createDashboardRoutes } from "../src/server.ts";
import { makeConfig, makeDb, seedWorkflow } from "../test/helpers.ts";

const { db } = makeDb();
db.run(
  `INSERT INTO epics (repo, ref, number, title, state, labels_json, sub_total, sub_closed, last_refreshed)
   VALUES ('o/alpha', '247', 247, 'OAuth refresh', 'open', '[]', 4, 2, 0)`,
);
seedWorkflow(db, {
  id: "wf1",
  repo: "o/alpha",
  epicNumber: 247,
  adapter: "claude",
  state: "running",
  sessionName: "mm-alpha-247",
  controlledBy: "middle",
  currentSubIssue: 2,
  transcriptPath: "/wt/alpha/transcript.jsonl",
  worktreePath: "/wt/alpha",
  prNumber: 251,
});

const deps = createDbDeps({
  db,
  config: makeConfig(),
  spawnTerminal: () => true,
  isSessionAlive: async () => true,
});
const routes = createDashboardRoutes(deps);

/** Stubbed `/control/metrics` snapshot — drives the Queue gauge tiles. */
const metrics = {
  workflows: [{ repo: "o/alpha", kind: "implementation", state: "running", count: 1 }],
  rateLimits: [{ adapter: "claude", status: "AVAILABLE" }],
  slots: { total: 3 },
  totals: { all: 2, active: 1, waitingHuman: 1 },
};

/** Stubbed `/control/events` — emits one waiting-human frame, then keeps the stream open. */
function controlEvents(): Response {
  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = { id: "wf-wh", repo: "o/alpha", epic: 248, state: "waiting-human" };
      controller.enqueue(enc.encode(`event: workflow\ndata: ${JSON.stringify(frame)}\n\n`));
      // A comment heartbeat keeps the connection alive; stop enqueuing once the
      // client disconnects (the controller closes) so it doesn't throw.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 10_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

const index = (await import("../src/index.html")).default;
const port = Number(process.env.PW_PORT ?? 41999);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 60,
  routes: {
    ...routes,
    "/control/metrics": () => Response.json(metrics),
    "/control/events": () => controlEvents(),
    "/*": index as unknown as never,
  },
});

// eslint-disable-next-line no-console
console.log(`dashboard playwright daemon listening on http://127.0.0.1:${port}`);
