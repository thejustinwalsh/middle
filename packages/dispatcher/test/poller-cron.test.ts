import { expect, test } from "bun:test";
import { POLLER_INTERVAL_MS } from "../src/poller-cron.ts";

// The dispatcher's CLAUDE.md fixes the cron cadence at WATCHDOG_INTERVAL_MS = 30s
// and POLLER_INTERVAL_MS = 60s. Earlier the file's literal had drifted to 120s
// and silently doubled production cadence (the cron uses this constant when
// `startPoller`'s `intervalMs` is omitted, which is the daemon's call shape).
// Pin the value here so a future shift surfaces as a test failure, not a slow
// reconciler the next reviewer has to rediscover.
test("POLLER_INTERVAL_MS matches the dispatcher CLAUDE.md cadence contract (60s)", () => {
  expect(POLLER_INTERVAL_MS).toBe(60_000);
});
