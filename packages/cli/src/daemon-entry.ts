/**
 * The process `mm start` spawns. The composition root that wires the dashboard
 * into the daemon: it depends on both `@middle/dispatcher` and `@middle/dashboard`
 * (the dispatcher cannot import the dashboard without a cycle), runs them in ONE
 * process so the rate-limit bridge reaches the daemon's process-global observers,
 * and merges the dashboard's routes onto the daemon's single server.
 *
 * `dashboardHostExtras` is exported (not just used) so tests exercise the real
 * wiring without booting the daemon; the actual `runDaemon` call is guarded by
 * `import.meta.main`.
 */
import index from "@middle/dashboard/src/index.html";
// Deep `src/` imports: `@middle/dashboard`'s package `main` is `server.ts`, which
// re-exports only the server surface. The composition root needs the deps + bridge
// factories that live in their own modules (the monorepo resolves deep `src/`
// specifiers across packages — see e.g. db-deps.ts importing the dispatcher).
import { bridgeRateLimitsToBus, bridgeWorkflowsToBus } from "@middle/dashboard/src/bridge.ts";
import { createDbDeps } from "@middle/dashboard/src/db-deps.ts";
import { DashboardEventBus } from "@middle/dashboard/src/events.ts";
import { createDashboardRoutes } from "@middle/dashboard/src/server.ts";
import { type DaemonHostContext, runDaemon } from "@middle/dispatcher";

/** Build the dashboard's routes + a shutdown disposer from the daemon's host context. */
export function dashboardHostExtras(ctx: DaemonHostContext): {
  routes: Record<string, unknown>;
  dispose: () => void;
} {
  const bus = new DashboardEventBus();
  const deps = createDbDeps({
    db: ctx.db,
    config: ctx.config,
    stateGateway: ctx.stateGateway,
    events: bus,
    runRecommender: ctx.runRecommender,
  });
  // Build the routes BEFORE registering the process-global observers. If route
  // construction throws, `runDaemon` catches it and runs the daemon dashboard-less
  // — and because no observer is registered yet, none leaks (left firing into an
  // orphaned bus for the daemon's lifetime). Mount the SPA at "/" (exact), NOT
  // "/*": a wildcard would shadow the hook server's fetch fallback (/health,
  // /control/*, /hooks/*). Bun still auto-serves the bundle's hashed JS/CSS assets.
  const routes = { ...createDashboardRoutes(deps), "/": index };

  // Live banner: a usage-limit detection broadcasts a fresh banner on the global
  // channel within ~2s. The bridge reaches the dispatcher's process-global
  // rate-limit observer, so this MUST run in-process (which it does — same daemon).
  const disposeBanner = bridgeRateLimitsToBus(bus, () => deps.banner());
  // Live per-repo views: a workflow transition broadcasts a `workflow` nudge on
  // that repo's channel so the dashboard's expanded-repo views refresh live
  // instead of polling. Reaches the dispatcher's process-global workflow observer,
  // so this MUST run in-process (which it does — same daemon).
  const disposeWorkflow = bridgeWorkflowsToBus(bus, ctx.db);
  // dispose tears down both bridges (rate-limit banner + per-repo workflow nudge).
  // The EventHub heartbeats self-stop with their last SSE subscriber, and the
  // daemon process.exits on shutdown, so the bus needs no explicit teardown in v1
  // (revisit if dispose must hard-close live SSE).
  return {
    routes,
    dispose: () => {
      disposeBanner();
      disposeWorkflow();
    },
  };
}

if (import.meta.main) {
  runDaemon({ hostExtras: dashboardHostExtras }).catch((error: unknown) => {
    console.error(`middle daemon failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
