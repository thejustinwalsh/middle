/**
 * Minimal ambient types for the optional `webview-bun` native module. It's an
 * optionalDependency (no prebuilt for every platform / CI), so it may be absent
 * at install time — but `window.ts` still type-checks against this declaration.
 * Only the subset the launcher uses is declared.
 */
declare module "webview-bun" {
  export class Webview {
    constructor(debug?: boolean);
    /** Set the window title. */
    setTitle(title: string): void;
    /** Navigate the webview to a URL. */
    navigate(url: string): void;
    /** Run the webview event loop (blocks until the window closes). */
    run(): void;
  }
}
