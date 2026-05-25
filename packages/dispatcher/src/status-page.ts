/**
 * The dispatcher's stopgap **queue observability** page, served at `GET /` (and
 * `/status`). A single self-contained HTML document — no build step, no assets —
 * that subscribes to `/control/events` for live workflow transitions and polls
 * `/control/metrics` for the aggregate gauges. It's engine observability (what's
 * in flight, parked, rate-limited), deliberately distinct from the task-
 * management dashboard (#54); when that lands this view folds into it as the
 * "queue" surface. Also the fastest way to debug/dogfood the autonomous loop.
 *
 * The inline script avoids template literals and uses `textContent` (never
 * `innerHTML` with live data), so the page can't be broken by — or inject — a
 * repo name or state string.
 */
export const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>middle · queue observability</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1115; color: #e6e8eb; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #23262d; position: sticky; top: 0; background: #0f1115; }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; }
  header .spacer { flex: 1; }
  .conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #9aa3ad; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #555; }
  .dot.live { background: #36d399; box-shadow: 0 0 6px #36d39988; }
  .dot.reconnecting { background: #fbbd23; }
  .dot.down { background: #f87272; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .needs-you { background: #2a2113; border: 1px solid #6b5417; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; color: #ffd479; font-weight: 600; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .tile { background: #161922; border: 1px solid #23262d; border-radius: 8px; padding: 14px 16px; }
  .tile .n { font-size: 26px; font-weight: 700; }
  .tile .l { font-size: 12px; color: #9aa3ad; text-transform: uppercase; letter-spacing: .5px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #9aa3ad; margin: 24px 0 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; background: #161922; border: 1px solid #23262d; border-radius: 999px; padding: 5px 12px; font-size: 13px; }
  .chip .c { width: 8px; height: 8px; border-radius: 50%; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1c1f27; font-size: 13px; }
  th { color: #9aa3ad; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  td.state { font-weight: 600; }
  .empty { color: #6b7280; padding: 14px 10px; font-style: italic; }
  a { color: #7aa2f7; }
  /* state colors */
  .s-running { color: #36d399; } .c-running { background: #36d399; }
  .s-launching, .s-pending { color: #7aa2f7; } .c-launching, .c-pending { background: #7aa2f7; }
  .s-waiting-human { color: #ffd479; } .c-waiting-human { background: #ffd479; }
  .s-rate-limited { color: #f87272; } .c-rate-limited { background: #f87272; }
  .s-completed { color: #5b9d7a; } .c-completed { background: #5b9d7a; }
  .s-failed, .s-cancelled, .s-compensated { color: #f87272; } .c-failed, .c-cancelled, .c-compensated { background: #9aa3ad; }
</style>
</head>
<body>
<header>
  <h1>middle · queue observability</h1>
  <span class="spacer"></span>
  <span class="conn"><span id="dot" class="dot"></span><span id="conn-label">connecting…</span></span>
  <span class="conn" id="updated"></span>
</header>
<main>
  <div id="needs-you" class="needs-you" style="display:none"></div>
  <div class="tiles">
    <div class="tile"><div class="n" id="t-active">–</div><div class="l">In flight</div></div>
    <div class="tile"><div class="n" id="t-waiting">–</div><div class="l">Needs you</div></div>
    <div class="tile"><div class="n" id="t-total">–</div><div class="l">Total workflows</div></div>
    <div class="tile"><div class="n" id="t-rl">–</div><div class="l">Rate-limited</div></div>
  </div>
  <section>
    <h2>State distribution</h2>
    <div class="chips" id="states"><span class="empty">no data yet</span></div>
  </section>
  <section>
    <h2>In flight &amp; parked</h2>
    <table>
      <thead><tr><th>Repo</th><th>Epic</th><th>State</th></tr></thead>
      <tbody id="active"><tr><td colspan="3" class="empty">nothing in flight</td></tr></tbody>
    </table>
  </section>
  <section>
    <h2>Adapters</h2>
    <div class="chips" id="rl"><span class="empty">no rate-limit data</span></div>
  </section>
  <section style="margin-top:28px;color:#6b7280;font-size:12px">
    Scrape <a href="/metrics">/metrics</a> (Prometheus) · raw <a href="/control/metrics">/control/metrics</a> (JSON).
    Stopgap ahead of the full dashboard.
  </section>
</main>
<script>
(function () {
  var TERMINAL = { completed: 1, compensated: 1, failed: 1, cancelled: 1 };
  var active = new Map();
  var lastMetricsAt = 0;
  var refreshTimer = null;

  function setConn(state, label) {
    document.getElementById("dot").className = "dot " + state;
    document.getElementById("conn-label").textContent = label;
  }

  function epicCell(epic) {
    return epic == null ? "—" : "#" + epic;
  }

  function renderActive() {
    var tbody = document.getElementById("active");
    tbody.textContent = "";
    if (active.size === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 3; td.className = "empty"; td.textContent = "nothing in flight";
      tr.appendChild(td); tbody.appendChild(tr);
      return;
    }
    var rows = Array.from(active.values());
    rows.sort(function (a, b) {
      if (a.state === "waiting-human" && b.state !== "waiting-human") return -1;
      if (b.state === "waiting-human" && a.state !== "waiting-human") return 1;
      return (a.repo + a.epic).localeCompare(b.repo + b.epic);
    });
    rows.forEach(function (w) {
      var tr = document.createElement("tr");
      var r = document.createElement("td"); r.textContent = w.repo || "—";
      var e = document.createElement("td"); e.textContent = epicCell(w.epic);
      var s = document.createElement("td"); s.className = "state s-" + w.state; s.textContent = w.state;
      tr.appendChild(r); tr.appendChild(e); tr.appendChild(s);
      tbody.appendChild(tr);
    });
  }

  function renderMetrics(m) {
    lastMetricsAt = Date.now();
    document.getElementById("t-active").textContent = m.totals.active;
    document.getElementById("t-waiting").textContent = m.totals.waitingHuman;
    document.getElementById("t-total").textContent = m.totals.all;
    var rlCount = m.rateLimits.filter(function (x) { return x.status === "RATE_LIMITED"; }).length;
    document.getElementById("t-rl").textContent = rlCount;

    var needs = document.getElementById("needs-you");
    if (m.totals.waitingHuman > 0) {
      needs.style.display = "";
      needs.textContent = m.totals.waitingHuman + " workflow(s) parked waiting for you — answer a question, review, or merge.";
    } else {
      needs.style.display = "none";
    }

    // State distribution (aggregate across repos/kinds).
    var byState = {};
    m.workflows.forEach(function (w) { byState[w.state] = (byState[w.state] || 0) + w.count; });
    var states = document.getElementById("states");
    states.textContent = "";
    var keys = Object.keys(byState).sort();
    if (keys.length === 0) {
      var es = document.createElement("span"); es.className = "empty"; es.textContent = "no data yet"; states.appendChild(es);
    }
    keys.forEach(function (k) {
      var chip = document.createElement("span"); chip.className = "chip";
      var c = document.createElement("span"); c.className = "c c-" + k;
      var t = document.createElement("span"); t.className = "s-" + k; t.textContent = k + " · " + byState[k];
      chip.appendChild(c); chip.appendChild(t); states.appendChild(chip);
    });

    // Adapters / rate limits.
    var rl = document.getElementById("rl");
    rl.textContent = "";
    if (m.rateLimits.length === 0) {
      var er = document.createElement("span"); er.className = "empty"; er.textContent = "no rate-limit data"; rl.appendChild(er);
    }
    m.rateLimits.forEach(function (x) {
      var chip = document.createElement("span"); chip.className = "chip";
      var limited = x.status === "RATE_LIMITED";
      var c = document.createElement("span"); c.className = "c " + (limited ? "c-rate-limited" : "c-running");
      var label = x.adapter + " · " + x.status;
      if (limited && x.resetAt) {
        var mins = Math.max(0, Math.round((x.resetAt - Date.now()) / 60000));
        label += " (resets ~" + mins + "m)";
      }
      var t = document.createElement("span"); t.textContent = label;
      chip.appendChild(c); chip.appendChild(t); rl.appendChild(chip);
    });
  }

  function fetchMetrics() {
    fetch("/control/metrics").then(function (r) {
      if (!r.ok) throw new Error("metrics " + r.status);
      return r.json();
    }).then(renderMetrics).catch(function () { /* transient; next tick retries */ });
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () { refreshTimer = null; fetchMetrics(); }, 250);
  }

  function upsert(d) {
    if (TERMINAL[d.state]) active.delete(d.id);
    else active.set(d.id, d);
    renderActive();
    scheduleRefresh();
  }

  var es = new EventSource("/control/events");
  es.onopen = function () { setConn("live", "live"); };
  es.onerror = function () { setConn("reconnecting", "reconnecting…"); };
  es.addEventListener("connected", function () { setConn("live", "live"); });
  es.addEventListener("workflow", function (ev) {
    try { upsert(JSON.parse(ev.data)); } catch (e) { /* ignore a malformed frame */ }
  });

  fetchMetrics();
  setInterval(fetchMetrics, 4000);
  setInterval(function () {
    if (!lastMetricsAt) return;
    var secs = Math.round((Date.now() - lastMetricsAt) / 1000);
    document.getElementById("updated").textContent = "updated " + secs + "s ago";
  }, 1000);
})();
</script>
</body>
</html>
`;
