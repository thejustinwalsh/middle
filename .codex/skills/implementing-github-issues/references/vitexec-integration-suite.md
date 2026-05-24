# Vitexec Integration Test Suite — Convention & Bootstrap Guide

Companion reference to `implementing-github-issues` and `resuming-github-issues`. Two purposes:

1. **Live debugging** — using `vitexec` ad-hoc to inspect a running app while you're in the loop.
2. **Suite scaffolding** — turning those one-off probes into a maintainable integration test suite when one doesn't exist yet.

Both skills point here. The conventions described below are agreed-on patterns across multiple projects; they're a reproducible blueprint, not a dictate. Any project's own `tests/integration/README.md` (or equivalent) is the local source of truth — defer to it when present.

## When to reach for vitexec

`vitexec` boots a headless Chromium against a Vite dev server, runs a code snippet inside the page, and pipes browser console output back to your terminal. It exists for the class of problems where:

- The bug only emerges in full-system play (multi-system races, timing, animation, agentic AI doing a thing it wouldn't in isolated tests).
- Static-analysis tests (vitest unit, typecheck) can't reach the invariant — the failure mode is observable only with active state, streaming data, real frame loops.
- You'd otherwise be debugging via `console.log` + manual reload + watch.

If a unit test can express the invariant, write the unit test. Vitexec is for the rest.

## Live debugging — the inner loop

When you're mid-implementation and need to inspect runtime state, write a probe and run it directly. Don't add it to the suite yet. Do it in `/tmp` or anywhere disposable.

```bash
cat > /tmp/my-debug-probe.js <<'EOF'
const start = Date.now()
while (!window.__myAppGlobal && Date.now() - start < 8000) {
  await new Promise((r) => setTimeout(r, 100))
}
const traits = await import('/src/traits/index.ts')
const w = window.__myAppGlobal
// poke at runtime state, sample over time, log JSON
const snapshot = { /* ... */ }
console.log('SNAPSHOT: ' + JSON.stringify(snapshot))
EOF

pnpm exec vitexec --gpu --path / --timeout 60 "$(cat /tmp/my-debug-probe.js)"
```

Three usability rules during live debugging:

- **`--gpu` is non-negotiable** for anything timing-, animation-, or render-dependent. Without it, headless Chromium throttles `requestAnimationFrame` to a sub-60Hz rate and your wall-clock observations are ~2× off the design target. The flag uses Chromium's new headless mode with GPU-friendly defaults.
- **Sentinel logging beats free-form prints.** `console.log('LABEL: ' + JSON.stringify(...))` is grep-friendly when you need to extract a value or feed the output into another tool.
- **Bound the run.** Pass `--timeout <seconds>` larger than the probe's internal `setTimeout` window, with margin. A hung browser swallows your terminal otherwise.

## When a debug probe earns its way into the suite

You've been chasing a bug. The probe surfaced it. Two questions:

1. **Was the bug a real codex/contract violation?** (Not a transient state, not user error, not a typo.)
2. **Could the same regression land later if the underlying invariant isn't pinned?**

If both yes, **fold the probe into the integration suite** in the same commit that fixes the bug. The probe is now the regression test.

## Suite layout — convention

If the project doesn't have a vitexec suite yet, scaffold one with this shape. The layout is what `implementing-github-issues` is referring to when it talks about the "integration test gate."

```
<package-root>/
  package.json          # add a "test:integration" script
  vitest.integration.config.ts   # separate config from unit tests
  vite.config.ts        # exclude integration/ from default unit test include
  tests/
    integration/
      README.md         # local conventions, gotchas, probe inventory
      _runner.ts        # spawns vitexec, parses INTEGRATION_RESULT, surfaces failures
      probes/
        <name>.probe.js     # browser-runnable, ends in INTEGRATION_RESULT sentinel
        ...
      <name>.integration.test.ts   # vitest harness — calls runProbe, asserts on result
      ...
```

### Why these specific decisions

- **Separate vitest config** so integration tests can have a much larger `testTimeout` (300s+) and explicit `pool: 'forks'` + `fileParallelism: false` (sequential — only one browser slot at a time).
- **Probes are plain `.js`, not `.ts`.** Vite serves them into the browser as-is; keeping them off the TS pre-compile path means the harness can read them with `fs.readFile` and feed them directly to vitexec. The trade-off (probes don't get type-checked) is acceptable — they're short, and the harness catches breakage immediately.
- **`_runner.ts`** is the one place that knows the vitexec subprocess shape. Tests stay readable: `const { data, log } = await runProbe('./probes/foo.probe.js', { timeoutSec: 150 })`.
- **`INTEGRATION_RESULT` sentinel** is the contract between probe and harness. Probes emit it via `console.log`. The runner regex-extracts it from stdout and `JSON.parse`s the payload.
- **Excluded from default `pnpm test`.** Default `vite.config.ts` excludes `tests/integration/**` from `test.include` so the unit-test inner loop stays fast (sub-second).

### Probe contract

Every probe MUST:

1. Wait for the app's runtime global (e.g., `window.__myAppWorld`) — the dev server may not have hydrated yet.
2. Sample state over time (`setInterval`) for some `RUN_MS` window.
3. Aggregate samples into a structured result object.
4. Emit `console.log('INTEGRATION_RESULT: ' + JSON.stringify(result))` as the LAST line.
5. Use `--gpu` (passed by the runner, not the probe).

Probes SHOULD:

- Emit periodic `[progress] ...` lines every ~10 seconds during long observations. The runner forwards these to stderr in real time so a 90s test isn't visually indistinguishable from a hang.
- Use a noise-filtered prefix the runner's forwarder recognizes (e.g., `[progress]`, `[debug]`) to avoid clogging output with framework banners.

### Harness contract

Every `*.integration.test.ts` MUST:

1. Import a shared `runProbe(probePath, { timeoutSec })` helper from `_runner.ts`.
2. `await` the runner; receive `{ data, log }`.
3. Assert on `data` with vitest matchers.
4. **On failure, throw an Error whose message includes:**
   - What was expected (the invariant in plain English).
   - Likely root causes with specific file paths to investigate.
   - Sample offending data (truncated to ~20 entries).
   - The tail of vitexec's stdout.

This is the maintenance contract — when a future agent (or you, later) sees the test fail, the message must give them enough to act without re-reading the debugging session that produced the test.

### Runner contract

`_runner.ts` MUST:

- Spawn `pnpm exec vitexec --config <vite-config> --gpu --path <path> --timeout <seconds> <code>` — pass the probe code as a literal argument (read from disk first).
- Stream child stdout to `process.stderr` in real time, with a probe-name prefix and a noise filter. The runner ALSO buffers stdout for sentinel parsing after exit.
- Enforce **three layers of failure detection** so a misconfigured suite can't burn 4 minutes on silence:
  1. **Fail-fast pattern match** (~1–3s) — stdout/stderr matched against a known-fatal regex (`vitexec failed:`, `EADDRINUSE`, `Port \d+ is already in use`, `failed to load config from`, missing Playwright browser, etc.). On match, `SIGKILL` and reject with a "killed early" message that quotes the matching pattern.
  2. **First-output deadline** (~30s) — if zero bytes have been emitted on either stdout OR stderr by the deadline, `SIGKILL` and reject with a "vitexec produced no output within Xs of spawn" message naming likely causes (vite config error, pnpm resolution error, missing playwright binary). Vite normally prints "VITE ready in …ms" within ~3s, so 30s of total silence means something is wrong before anything had a chance to log.
  3. **Hard timeout** (`timeoutSec + ~60s` margin) — final envelope. On overshoot, `SIGKILL` and reject with the standard "hard-timed-out" message.
- Reject with a clear error if the child exits non-zero, if no `INTEGRATION_RESULT` sentinel is found, or if the JSON is malformed.

A timeout is a failure, not a "skipped" or "in-progress" — silence is never green. The fail-fast pattern set is conservative: each pattern should correspond to a real debugging session where the wall-clock cost of waiting for the hard timeout was high and the fix was obvious from the message. Add a pattern only after that friction has been felt; false positives short-circuit working tests.

### Port handling — `strictPort:false` + free-port pre-pick

The integration suite's vite config MUST read its port from an env var (e.g. `$<APP>_INTEGRATION_PORT`) and use `strictPort: false`. The runner pre-allocates a free OS port via `net.createServer().listen(0)` before each spawn and passes it through the env, so the suite never collides with a workspace dev server holding port 5173. If the picked port gets stolen between bind and vite-startup (rare race), the runner retries — up to ~3 times — only on port-collision-style errors. Other failures surface immediately.

This matters because workspaces with multiple worktrees / multiple dev servers running simultaneously can hold the default Vite port (5173) for hours; a `strictPort:true` integration config will hang silently against that.

## Game-side counters: the cleanest signal

Probes that scrape grid state (or DOM, or any user-visible surface) often can't distinguish two scenarios that look identical externally. When that's the case, **instrument the simulation with monotonically-increasing counters exposed via `window.__<app>Stats`** and read the counters from the probe.

Example: in a falling-block game, a "cell that went AIR then became solid again at the same index" could be (a) a real codex violation (chunk landed at its own release row) or (b) legitimate (sibling chunk landed on top of a freshly-released cell). Externally identical. Solution: increment `window.__appStats.zeroDisplacementRestores` from inside the system's belt-and-suspenders restore branch (which only fires for real violations). Probe samples `(after - before)` deltas around the observation window. Unambiguous.

The counter implementation is trivial — a plain object on `window`, mutated by the system. Test isolation: the probe takes a snapshot at start, subtracts from end. No global reset needed.

## Verbose reporter, sequential execution

The integration vitest config should set:

```ts
reporters: ['verbose'],          // print each test name as it starts and ✓/✗ as it completes
fileParallelism: false,          // one browser at a time
pool: 'forks',
poolOptions: { forks: { singleFork: true } },
testTimeout: 300_000,            // outer bound; runner has its own hard timeout
hookTimeout: 60_000,
```

Without `verbose` and the runner's per-probe progress markers, slow tests show no output for 90+ seconds and the user can't tell if the suite is alive.

## Fold-back checklist

When you've debugged a bug with a one-off vitexec probe and want to fold it into the suite:

1. Move the probe from `/tmp` (or wherever) to `tests/integration/probes/<name>.probe.js`.
2. Add periodic `[progress]` markers if absent.
3. Replace any `console.log('SNAPSHOT: ...')` with `console.log('INTEGRATION_RESULT: ...')` at the end.
4. Write a `<name>.integration.test.ts` harness that calls `runProbe` and asserts on the structured result.
5. Make the harness's failure message specific to the bug — name the system file(s) most likely to be the cause, give sample data shape.
6. Run `pnpm test:integration <name>` (or the project's equivalent filter) to confirm green.
7. Commit the probe, the harness, AND the bug fix together. The diff should read like a coherent story: "I broke this; here's the regression test that catches it; here's the fix."

## Common failure modes when scaffolding from scratch

- **Forgetting `--gpu`** → timing assertions are off by 2×; integration tests fail or pass non-deterministically.
- **Probes in TS** → the `?inline` / `?raw` import dance is annoying; vite's TS-in-browser path may not exist in your config. Just keep probes as `.js`.
- **No hard timeout in the runner** → a hung browser hangs the test runner forever.
- **Sentinel parsing too greedy** → if a probe accidentally `console.log`s another `INTEGRATION_RESULT:` line during progress reporting, the regex grabs the wrong one. The runner regex should anchor on the LAST occurrence (or be a `\s*$` end-of-message anchor).
- **Tests run in parallel** → two browsers race for the same dev-server port; one test fails to bootstrap. Use `fileParallelism: false`.
- **No verbose reporter** → suite looks like a hang; users abort and assume the tests are broken.

## Reference: project-local docs

Every project that ships an integration suite SHOULD have a `tests/integration/README.md` documenting:

- What to run (`pnpm test:integration` or equivalent).
- When to run it (after touching the simulation pipeline; before opening a PR; not on every commit).
- The probe / harness contracts (often a re-statement of this doc, with project-specific globals named).
- The list of currently committed probes and what each pins.

If you're scaffolding a suite, write that README in the same commit — it's the durable artifact that survives across agent sessions.
