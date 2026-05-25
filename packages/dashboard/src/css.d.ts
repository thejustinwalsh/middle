/**
 * Ambient declaration for CSS side-effect imports. Bun's bundler turns
 * `import "./styles.css"` into a stylesheet link at build time; tsc only needs
 * to know the specifier resolves to a module with no value.
 */
declare module "*.css";
