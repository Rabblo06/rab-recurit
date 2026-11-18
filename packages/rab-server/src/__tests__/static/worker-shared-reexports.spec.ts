import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * engine/worker-shared/ is the Worker's import surface into rab-server (tools/check-import-boundaries.cjs, WORKER_SURFACE):
 * a Worker file may import it without counting as a deep import. The checker cannot see THROUGH a re-export, so a file here
 * that re-exports rab-server code at run time opens that code to the Worker without growing the boundary baseline. That is
 * allowed only by a reviewed entry below (security review of #241; the owner is asked to accept the pattern).
 *
 * A RUNTIME re-export, found with the TypeScript parser in every non-spec file of the folder:
 *   - `export { a, b as c } from '...'` and `export * [as ns] from '...'` (a type-only `export type { … } from` and
 *     per-element `type` names carry no runtime value and are ignored);
 *   - `export { x }` / `export default x` of a name bound by a value import of this file (`import { x } from '...'`),
 *     and `export import x = require('...')`.
 * Each is recorded as `<name> from <module specifier>`; the list per file must equal the allow-list exactly.
 */
const SURFACE = path.resolve(__dirname, '../../engine/worker-shared');

const ALLOWED_RUNTIME_REEXPORTS: Record<string, { reexports: string[]; why: string }> = {
  'maintenance-session-binder.ts': {
    reexports: ['bindMaintenanceSessionGucs from ../core-modules/tenant/tenant-context.service'],
    why:
      "the account-invite cleanup's level-22 pass binds the worker marker through the one binding statement; the callers of " +
      'the function are pinned in tenant-binder-callers.spec.ts',
  },
};

function runtimeReexports(text: string, fileName = 'surface.ts'): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map<string, string>(); // local value binding -> module specifier
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && !st.importClause?.isTypeOnly) {
      const from = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.name) imported.set(clause.name.text, from);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imported.set(nb.name.text, from);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) imported.set(el.name.text, from);
    }
  }
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const clause = st.exportClause;
      if (from && !clause) out.push(`* from ${from}`);
      else if (from && clause && ts.isNamespaceExport(clause)) out.push(`* as ${clause.name.text} from ${from}`);
      else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          const local = (el.propertyName ?? el.name).text;
          if (from) out.push(`${el.name.text} from ${from}`);
          else if (imported.has(local)) out.push(`${el.name.text} from ${imported.get(local)}`);
        }
      }
    } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression) && imported.has(st.expression.text)) {
      out.push(`default from ${imported.get(st.expression.text)}`);
    } else if (ts.isImportEqualsDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && !st.isTypeOnly) {
      const ref = st.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) out.push(`${st.name.text} from ${ref.expression.text}`);
    }
  }
  return out.sort();
}

describe('engine/worker-shared/: runtime re-exports are only the reviewed ones (static)', () => {
  const files = fs
    .readdirSync(SURFACE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .sort();

  it('scans the real surface', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toEqual(expect.arrayContaining(Object.keys(ALLOWED_RUNTIME_REEXPORTS)));
  });

  it('the parser recognises every runtime re-export form, and ignores type-only ones', () => {
    expect(runtimeReexports("export { a, b as c } from './m';")).toEqual(['a from ./m', 'c from ./m']);
    expect(runtimeReexports("export * from './m';")).toEqual(['* from ./m']);
    expect(runtimeReexports("export * as ns from './m';")).toEqual(['* as ns from ./m']);
    expect(runtimeReexports("import { x, y as z } from './m';\nexport { x, z as w };")).toEqual(['w from ./m', 'x from ./m']);
    expect(runtimeReexports("import d from './m';\nexport default d;")).toEqual(['default from ./m']);
    expect(runtimeReexports("import * as n from './m';\nexport { n };")).toEqual(['n from ./m']);
    expect(runtimeReexports("export import r = require('./m');")).toEqual(['r from ./m']);
    expect(runtimeReexports("export type { T } from './m';\nexport { type U } from './m';\nimport type { V } from './m';\nexport { V };")).toEqual([]);
    expect(runtimeReexports("export const LOCAL = 1;\nexport function f() {}\nconst y = 2;\nexport { y };")).toEqual([]);
  });

  it('every file re-exports exactly what its entry allows (a new runtime re-export, or a stale entry, fails)', () => {
    const actual = Object.fromEntries(
      files.map((f) => [f, runtimeReexports(fs.readFileSync(path.join(SURFACE, f), 'utf8'), f)] as const).filter(([, r]) => r.length > 0),
    );
    const expected = Object.fromEntries(Object.entries(ALLOWED_RUNTIME_REEXPORTS).map(([f, v]) => [f, [...v.reexports].sort()]));
    expect(actual).toEqual(expected);
  });

  it('every entry carries a reason', () => {
    for (const { why } of Object.values(ALLOWED_RUNTIME_REEXPORTS)) expect(why.length).toBeGreaterThan(20);
  });
});
