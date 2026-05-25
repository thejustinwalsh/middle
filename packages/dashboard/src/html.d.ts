/**
 * Ambient declaration for Bun HTMLBundle imports. Bun's bundler turns
 * `import index from "./index.html"` into a bundled SPA entry at build time; tsc
 * only needs to know the specifier resolves to a module with a default export.
 */
declare module "*.html" {
  const html: unknown;
  export default html;
}
