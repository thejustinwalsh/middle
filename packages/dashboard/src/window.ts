/**
 * The optional `webview-bun` window launcher. `mm start --window` spawns this as
 * its own process with the dashboard URL as `argv[2]` once the HTTP server is
 * up. This is the **only** module that imports `webview-bun`, so the default
 * (HTTP-only) path never loads the native dependency — the import is dynamic and
 * happens here, in a separate process, behind the flag.
 *
 * `webview-bun` is an `optionalDependency`: if it isn't installed (no prebuilt
 * for the platform, headless CI), the launcher logs and exits 0 — the dashboard
 * is still served over HTTP, the window is just unavailable.
 */

const url = process.argv[2];
if (!url) {
  console.error("dashboard window: missing URL argument (usage: bun window.ts <url>)");
  process.exit(2);
}

try {
  const { Webview } = await import("webview-bun");
  const webview = new Webview();
  webview.setTitle("middle");
  webview.navigate(url);
  webview.run(); // blocks until the window is closed
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `dashboard window: webview-bun unavailable (${message}); the dashboard is served at ${url} over HTTP`,
  );
  process.exit(0);
}
