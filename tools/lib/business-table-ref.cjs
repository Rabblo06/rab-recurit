'use strict';
/**
 * Part C2: the ONE place that decides whether an interpolated expression is the businessTables(manager) primitive.
 * Shared by tools/check-sql-injection.cjs and tools/check-workspace-table-qualified.cjs (review finding #1: deciding by the
 * variable NAME let `const t = body; `…${t.venue}…`` pass both tools).
 *
 * `X.<table>` is the primitive only when ALL hold:
 *   - <table> is one of WORKSPACE_TABLES (read from database/typeorm/workspace-schema/workspace-tables.ts);
 *   - X is a plain identifier whose NEAREST declaration in an enclosing scope is `const X = businessTables(<expr>)`
 *     (parentheses, `as`/`satisfies`/non-null wrappers around the call allowed; nothing else: no `let`, no parameter, no
 *     destructuring, no import, no reassignable binding, no other initializer; a hoisted `var X` anywhere in an enclosing
 *     function voids it);
 *   - that `businessTables` callee is itself resolved the same way: its nearest declaration must be the NON-aliased value
 *     import `import { businessTables } from '<…>/tenant/business-tables'` (or `./business-tables` inside tenant/) — not a
 *     local function, an aliased import, a parameter, or nothing (re-review MEDIUM: the callee name alone is not trusted);
 *   - the interpolation is not inside quotes in the surrounding SQL text ('${…}' / "${…}" — a quoted value is a string
 *     literal or a single identifier, never the qualified "schema"."table" pair the primitive returns).
 * Anything else is not exempt: check-sql-injection asks for a reviewed comment, the ratchet counts it.
 *
 * Uses the repository's own `typescript` (resolved from the repo root). When it cannot be loaded, nothing is exempt
 * (fail closed).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TABLES_FILE = 'packages/rab-server/src/database/typeorm/workspace-schema/workspace-tables.ts';

/** WORKSPACE_TABLES from the leaf module's text (a single `as const` array of quoted lower-case names). */
function loadTables(root = ROOT) {
  const src = fs.readFileSync(path.join(root, TABLES_FILE), 'utf8');
  const m = src.match(/export const WORKSPACE_TABLES = \[([\s\S]*?)\] as const;/);
  const tables = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
  if (tables.length === 0 || new Set(tables).size !== tables.length) throw new Error(`${TABLES_FILE}: WORKSPACE_TABLES is empty, missing or has duplicates`);
  return tables;
}

let tsCache;
/** The repo's typescript module, or null when it cannot be loaded (then nothing is exempt). */
function loadTypeScript(root = ROOT) {
  if (tsCache === undefined) {
    try {
      tsCache = require(require.resolve('typescript', { paths: [root] }));
    } catch {
      tsCache = null;
    }
  }
  return tsCache;
}

/** `X.<name>` text shape only (a cheap pre-filter before parsing). */
function candidateText(expr, tables) {
  const m = /^([A-Za-z_$][\w$]*)\.([a-z_]+)$/.exec(expr);
  return Boolean(m && tables.includes(m[2]));
}

function unwrap(ts, e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)) || ts.isTypeAssertionExpression?.(e))) e = e.expression;
  return e;
}

/** Declarations of `name` made directly by `scope` (not by nested scopes). */
function declarationsIn(ts, scope, name) {
  const found = [];
  const fromList = (list) => {
    for (const d of list.declarations) {
      if (ts.isIdentifier(d.name)) { if (d.name.text === name) found.push(d); }
      else if (bindsName(ts, d.name, name)) found.push(d.name); // destructuring: never exempt
    }
  };
  const fromStatements = (statements) => {
    for (const s of statements) {
      if (ts.isVariableStatement(s)) fromList(s.declarationList);
      else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name?.text === name) found.push(s);
      else if (ts.isImportDeclaration(s) && s.importClause) {
        const c = s.importClause;
        if (c.name?.text === name) found.push(c);
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings) && c.namedBindings.name.text === name) found.push(c.namedBindings);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) if (el.name.text === name) found.push(el);
      }
    }
  };
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) fromStatements(scope.statements);
  else if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) fromStatements(scope.statements);
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters ?? []) if (bindsName(ts, p.name, name)) found.push(p);
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression?.(scope)) && scope.name?.text === name) found.push(scope);
  }
  if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) fromList(scope.initializer);
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(ts, scope.variableDeclaration.name, name)) found.push(scope.variableDeclaration);
  return found;
}

function bindsName(ts, binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    return binding.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(ts, el.name, name));
  }
  return false;
}

/**
 * True when `body` declares `var <name>` anywhere (blocks included, nested functions excluded): a `var` is hoisted to the
 * whole function, so it can shadow a `const` the block walk would otherwise find (re-review MEDIUM).
 */
function declaresVar(ts, body, name) {
  let found = false;
  const visit = (x) => {
    if (found || (x !== body && ts.isFunctionLike(x))) return;
    if (ts.isVariableDeclarationList(x) && (x.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      if (x.declarations.some((d) => bindsName(ts, d.name, name))) { found = true; return; }
    }
    ts.forEachChild(x, visit);
  };
  visit(body);
  return found;
}

/** Any enclosing function (or the file) of `node` has a hoisted `var <name>`. */
function hoistedVarShadows(ts, node, name) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isSourceFile(n) && declaresVar(ts, n, name)) return true;
    if (ts.isFunctionLike(n) && n.body && declaresVar(ts, n.body, name)) return true;
  }
  return false;
}

/** The single nearest declaration of `ident` (block scopes, parameters, imports), or null when absent/ambiguous/var-hoisted. */
function nearestDeclaration(ts, ident) {
  const name = ident.text;
  if (hoistedVarShadows(ts, ident, name)) return null;
  for (let scope = ident.parent; scope; scope = scope.parent) {
    const decls = declarationsIn(ts, scope, name);
    if (decls.length === 0) continue;
    return decls.length === 1 ? decls[0] : null;
  }
  return null;
}

/** The module that may export the primitive: `…/tenant/business-tables` (server relative path or '@rab/server/…'). */
const BUSINESS_TABLES_MODULE = /(?:^|\/)tenant\/business-tables$/;
const TENANT_DIR = /(?:^|\/)engine\/core-modules\/tenant\/[^/]+$/;

/**
 * The callee `businessTables` really is the primitive: its nearest declaration is a NON-aliased, value (not type-only)
 * `import { businessTables } from '<…>/tenant/business-tables'` (or `./business-tables` from a file inside tenant/).
 * A local function, an aliased import (`{ evil as businessTables }`), a parameter, a default/namespace import or no
 * declaration at all is not.
 */
function calleeIsBusinessTables(ts, callee) {
  if (!ts.isIdentifier(callee) || callee.text !== 'businessTables') return false;
  const d = nearestDeclaration(ts, callee);
  if (!d || !ts.isImportSpecifier(d) || d.propertyName !== undefined || d.isTypeOnly) return false;
  const decl = d.parent?.parent?.parent; // ImportSpecifier → NamedImports → ImportClause → ImportDeclaration
  if (!decl || !ts.isImportDeclaration(decl) || decl.importClause?.isTypeOnly || !ts.isStringLiteral(decl.moduleSpecifier)) return false;
  const spec = decl.moduleSpecifier.text;
  if (BUSINESS_TABLES_MODULE.test(spec)) return true;
  return spec === './business-tables' && TENANT_DIR.test(callee.getSourceFile().fileName.replace(/\\/g, '/'));
}

/** True when `ident`'s nearest enclosing declaration is `const <ident> = businessTables(…)` with the real primitive. */
function resolvesToBusinessTables(ts, ident) {
  const d = nearestDeclaration(ts, ident);
  if (!d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name)) return false;
  const list = d.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
  const init = unwrap(ts, d.initializer);
  return Boolean(init && ts.isCallExpression(init) && calleeIsBusinessTables(ts, init.expression));
}

/** `node` is `X.<table>` with X resolving to `const X = businessTables(…)`. Quote context is checked by the callers below. */
function isPrimitiveRefNode(ts, node, tables) {
  const e = unwrap(ts, node);
  return Boolean(
    e && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isIdentifier(e.name) && tables.includes(e.name.text) && resolvesToBusinessTables(ts, e.expression),
  );
}

const QUOTE = /['"]$/;
const OPEN_QUOTE = /^['"]/;
/** Template span `i` of `tpl` is the primitive: a valid ref AND not between quotes in the literal text around it. */
function isPrimitiveSpan(ts, tpl, i, tables) {
  const span = tpl.templateSpans[i];
  const before = i === 0 ? tpl.head.text : tpl.templateSpans[i - 1].literal.text;
  const after = span.literal.text;
  if (QUOTE.test(before) || OPEN_QUOTE.test(after)) return false;
  return isPrimitiveRefNode(ts, span.expression, tables);
}

/**
 * For check-sql-injection's own template tokenizer: Map<template start offset (the backtick), boolean[] per interpolation>
 * marking which interpolations are the primitive. Empty when typescript is unavailable (fail closed).
 */
function primitiveSpansByTemplateStart(src, tables, fileName = 'file.ts', root = ROOT) {
  const out = new Map();
  const ts = loadTypeScript(root);
  if (!ts) return out;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const visit = (n) => {
    if (ts.isTemplateExpression(n)) out.set(n.getStart(sf), n.templateSpans.map((_s, i) => isPrimitiveSpan(ts, n, i, tables)));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

module.exports = { loadTables, loadTypeScript, candidateText, isPrimitiveRefNode, isPrimitiveSpan, resolvesToBusinessTables, primitiveSpansByTemplateStart, TABLES_FILE };
