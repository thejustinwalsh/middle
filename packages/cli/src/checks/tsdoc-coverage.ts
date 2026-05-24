import { join } from "node:path";
import ts from "typescript";
import { findIndexFiles, PACKAGES_DIR } from "./module-index.ts";

/**
 * @packageDocumentation
 * @module @middle/cli/checks/tsdoc-coverage
 *
 * The TSDoc-coverage check (#93): every symbol re-exported from a package's
 * `index.ts(x)` should carry a doc comment so `starlight-typedoc` has prose to
 * render. This is **advisory** — `@packageDocumentation` presence is the gated
 * guarantee (the module-index check); coverage is an honest backlog signal, not
 * a build break.
 *
 * Public surface:
 * - `checkTsdocCoverage` — analyze each index's public surface, report gaps
 * - `TsdocCoverageReport`, `UndocumentedExport` — the report shape
 *
 * Where things live:
 * - this file — a small wrapper over the TypeScript compiler API
 *
 * Gotchas:
 * - Re-exports are aliases; the checker resolves them to the original
 *   declaration before reading its JSDoc, so `export { x } from "./y.ts"` is
 *   judged by `y.ts`'s comment, not the re-export line.
 *
 * claude-md: false
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

export type UndocumentedExport = {
  /** The `@module` name (or the index path) the export belongs to. */
  module: string;
  /** The exported identifier lacking a doc comment. */
  name: string;
};

export type TsdocCoverageReport = {
  /** Total public exports across all scanned index files. */
  totalExports: number;
  /** Exports whose resolved declaration has no doc comment. */
  undocumented: UndocumentedExport[];
};

/** Parse the repo tsconfig once so the program shares the real compiler options. */
function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = join(REPO_ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, REPO_ROOT);
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

/** The `@module <name>` declared in a source file's leading block, if any. */
function moduleNameOf(sourceText: string, fallback: string): string {
  return sourceText.match(/@module\s+(\S+)/)?.[1] ?? fallback;
}

/**
 * Analyze the public surface of every `index.ts(x)` under `packagesDir` and
 * report which exports lack a doc comment. Pure read — builds an in-memory
 * TypeScript program, enumerates each module's exports, and resolves re-export
 * aliases to the original declaration before reading its JSDoc.
 */
export function checkTsdocCoverage(opts: { packagesDir?: string } = {}): TsdocCoverageReport {
  const packagesDir = opts.packagesDir ?? PACKAGES_DIR;
  const indexFiles = findIndexFiles(packagesDir);
  const program = ts.createProgram(indexFiles, loadCompilerOptions());
  const checker = program.getTypeChecker();

  let totalExports = 0;
  const undocumented: UndocumentedExport[] = [];

  for (const file of indexFiles) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) continue; // a bare `export {}` module has no symbol
    const moduleName = moduleNameOf(source.getFullText(), file);

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      totalExports += 1;
      const resolved =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (resolved.getDocumentationComment(checker).length === 0) {
        undocumented.push({ module: moduleName, name: exported.getName() });
      }
    }
  }

  return { totalExports, undocumented };
}
