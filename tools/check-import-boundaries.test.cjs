'use strict';
/**
 * Tests for tools/check-import-boundaries.cjs (untangle wave 1 import-boundary ratchet). Node built-ins plus the repo's
 * own `typescript` (the scanner reads TS imports with ts.preProcessFile).
 *   node --test tools/check-import-boundaries.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const check = require('./check-import-boundaries.cjs');

const ts = check.loadTypeScript();
const ENGINE = 'packages/rab-server/src/engine/core-modules/auth/services/x.service.ts';
const MODULE_ENTITY = 'packages/rab-server/src/modules/identity/entities/user.entity.ts';
const WORKER = 'packages/rab-worker/src/queues/rab-shifts/x.job.ts';
const FRONT = 'packages/rab-front/src/features/settings/Thing.tsx';
const MOBILE = 'packages/rab-mobile/lib/features/home/home_screen.dart';
const FILES = new Set([
  ENGINE, MODULE_ENTITY,
  'packages/rab-server/src/modules/identity/entities/index.ts',
  'packages/rab-server/src/engine/core-modules/tenant/business-tables.ts',
  'packages/rab-server/src/engine/worker-shared/queue-registry.ts',
  'packages/rab-server/src/modules/attendance/services/report-readiness.ts',
  WORKER,
  FRONT,
  'packages/rab-front/src/features/auth/AuthLayout.tsx',
  'packages/rab-front/src/features/settings/LogoutDialog.tsx',
  'packages/rab-front/src/shared/api.ts',
  MOBILE,
  'packages/rab-mobile/lib/features/offers/offers_provider.dart',
  'packages/rab-mobile/lib/features/home/home_card.dart',
  'packages/rab-mobile/lib/core/api/api_client.dart',
]);
const rules = (file, src) => check.scanSource(file, src, FILES, ts).map((s) => s.rule);

test('the typescript pre-processor is available (the check refuses to run without it)', () => {
  assert.ok(ts, 'yarn install first');
  assert.throws(() => check.specifiersOf('a.ts', "import x from './y';", null), /needs the repository's `typescript`/);
});

test('engine-to-modules: every import form into modules/ is flagged; engine and shared targets are not', () => {
  assert.deepEqual(rules(ENGINE, "import { User } from '../../../../modules/identity/entities';"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "import type { User } from '../../../../modules/identity/entities/user.entity';"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "export * from '../../../../modules/identity/entities';"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "const m = await import('../../../../modules/identity/entities');"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "const m = require('../../../../modules/identity/entities/user.entity');"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "import { X } from '@rab/server/modules/identity/entities';"), ['engine-to-modules']);
  assert.deepEqual(rules(ENGINE, "import { businessTables } from '../../tenant/business-tables';\nimport { money } from '@rab/shared';"), []);
});

test('comments and strings that look like imports are not imports', () => {
  assert.deepEqual(rules(ENGINE, "// import { User } from '../../../../modules/identity/entities';\n/* import x from '../../../../modules/identity/entities'; */"), []);
  assert.deepEqual(rules(ENGINE, "const doc = \"import { User } from '../../../../modules/identity/entities'\";"), []);
});

test('modules -> engine is the allowed direction', () => {
  assert.equal(check.classify(MODULE_ENTITY, 'packages/rab-server/src/engine/core-modules/tenant/business-tables.ts'), null);
});

test('worker-deep-import: any rab-server file outside engine/worker-shared, by alias, bare package or relative path', () => {
  assert.deepEqual(rules(WORKER, "import { x } from '@rab/server/modules/attendance/services/report-readiness';"), ['worker-deep-import']);
  assert.deepEqual(rules(WORKER, "import { x } from '@rab/server/modules/attendance/services/report-readiness.js';"), ['worker-deep-import']);
  assert.deepEqual(rules(WORKER, "import '@rab/server/instrument';"), ['worker-deep-import']);
  assert.deepEqual(rules(WORKER, "import { x } from '@rab/server';"), ['worker-deep-import']);
  assert.deepEqual(rules(WORKER, "import { x } from '../../../../rab-server/src/modules/attendance/services/report-readiness';"), ['worker-deep-import']);
  assert.deepEqual(rules(WORKER, "import { x } from '@rab/server/dist/modules/attendance/services/report-readiness';"), ['worker-deep-import']);
  // A missing server file is still a deep import (never silently skipped because it does not resolve).
  assert.deepEqual(rules(WORKER, "import { x } from '@rab/server/modules/not-a-real-file';"), ['worker-deep-import']);
  // The declared surface, other workspace libraries and the Worker's own files are fine.
  assert.deepEqual(rules(WORKER, "import { QUEUE } from '@rab/server/engine/worker-shared/queue-registry';"), []);
  assert.deepEqual(rules(WORKER, "import { formatPence } from '@rab/shared';\nimport { y } from './y';\nimport { Queue } from 'bullmq';"), []);
});

test('front-feature-to-feature: another feature is flagged; the same feature and shared/ are not', () => {
  assert.deepEqual(rules(FRONT, "import { AuthLayout } from '../auth/AuthLayout';"), ['front-feature-to-feature']);
  assert.deepEqual(rules(FRONT, "const P = lazy(() => import('../auth/AuthLayout'));"), ['front-feature-to-feature']);
  assert.deepEqual(rules(FRONT, "import { LogoutDialog } from './LogoutDialog';\nimport { api } from '../../shared/api';\nimport React from 'react';"), []);
});

test('mobile-feature-to-feature: package:rab_staff and relative imports of another feature; core/ and same feature are not', () => {
  assert.deepEqual(rules(MOBILE, "import 'package:rab_staff/features/offers/offers_provider.dart';"), ['mobile-feature-to-feature']);
  assert.deepEqual(rules(MOBILE, "import '../offers/offers_provider.dart';"), ['mobile-feature-to-feature']);
  assert.deepEqual(rules(MOBILE, "export 'package:rab_staff/features/offers/offers_provider.dart' show X;"), ['mobile-feature-to-feature']);
  assert.deepEqual(
    rules(MOBILE, "import 'dart:async';\nimport 'package:flutter/material.dart';\nimport 'package:rab_staff/core/api/api_client.dart';\nimport 'home_card.dart';"),
    [],
  );
});

test('test files, test kits and fixtures are out of scope', () => {
  for (const f of [
    'packages/rab-server/src/engine/core-modules/auth/services/x.service.spec.ts',
    'packages/rab-server/src/engine/core-modules/auth/__tests__/x.ts',
    'packages/rab-worker/src/__tests__/helpers/x.ts',
    'packages/rab-worker/src/jest-setup.ts',
    'packages/rab-front/src/features/settings/admin-panel/adminPanelTestKit.tsx',
    'packages/rab-front/src/features/settings/Thing.spec.tsx',
    'packages/rab-mobile/lib/features/home/home_screen_test.dart',
  ]) {
    assert.ok(check.isTestFile(f), f);
    assert.deepEqual(check.scanSource(f, "import { x } from '@rab/server/modules/a';\nimport '../offers/offers_provider.dart';", FILES, ts), [], f);
  }
  assert.equal(check.isTestFile(ENGINE), false);
  assert.equal(check.isTestFile(FRONT), false);
});

test('files outside the scanned roots are never classified', () => {
  assert.deepEqual(check.scanSource('packages/rab-server/src/modules/staff/x.ts', "import '../../../../rab-worker/src/main';", FILES, ts), []);
  assert.deepEqual(check.scanSource('tools/x.ts', "import '../packages/rab-server/src/modules/a';", FILES, ts), []);
});

test('compare: more edges than the baseline is NEW, fewer is STALE, both fail', () => {
  const baseline = { 'engine-to-modules': { a: 2 }, 'worker-deep-import': { w: 1 } };
  assert.deepEqual(check.compare({ 'engine-to-modules': { a: 2 }, 'worker-deep-import': { w: 1 } }, baseline), { grown: [], stale: [] });
  const r = check.compare({ 'engine-to-modules': { a: 3 }, 'front-feature-to-feature': { f: 1 } }, baseline);
  assert.deepEqual(r.grown.map((g) => `${g.rule}:${g.file}`), ['engine-to-modules:a', 'front-feature-to-feature:f']);
  assert.deepEqual(r.stale.map((g) => `${g.rule}:${g.file}`), ['worker-deep-import:w']);
});

test('compareToBase: a raised count or a new entry has grown; a lowered or deleted entry has not', () => {
  const base = { 'engine-to-modules': { a: 2, b: 1 } };
  assert.deepEqual(check.compareToBase(base, { 'engine-to-modules': { a: 1 } }).grown, []);
  const g = check.compareToBase(base, { 'engine-to-modules': { a: 3, b: 1 }, 'worker-deep-import': { w: 1 } }).grown;
  assert.deepEqual(g.map((x) => [x.rule, x.file, x.newKey]), [['engine-to-modules', 'a', false], ['worker-deep-import', 'w', true]]);
});

test('parseBaseline refuses unknown rules, zero or negative counts and malformed documents', () => {
  assert.throws(() => check.parseBaseline('{"files":{}}', 'x'), /"rules" object/);
  assert.throws(() => check.parseBaseline('{"rules":{"nope":{}}}', 'x'), /unknown rule/);
  assert.throws(() => check.parseBaseline('{"rules":{"engine-to-modules":{"a":0}}}', 'x'), /positive integer/);
  assert.throws(() => check.parseBaseline('{"rules":{"engine-to-modules":{"a":1.5}}}', 'x'), /positive integer/);
  assert.throws(() => check.parseBaseline('{"rules":{"engine-to-modules":[]}}', 'x'), /map files to counts/);
  assert.deepEqual(check.parseBaseline('{"rules":{"engine-to-modules":{"a":1}}}', 'x'), { 'engine-to-modules': { a: 1 } });
});

test('the committed baseline matches the tree, and a planted violation on top of it fails', () => {
  const root = path.resolve(__dirname, '..');
  const baseline = check.parseBaseline(fs.readFileSync(path.join(root, check.BASELINE_REL), 'utf8'), 'baseline');
  const sites = check.scan(root);
  assert.deepEqual(check.compare(check.countsOf(sites), baseline), { grown: [], stale: [] });
  const planted = check.scanSource(ENGINE, "import { User } from '../../../../modules/identity/entities';", FILES, ts);
  const { grown } = check.compare(check.countsOf([...sites, ...planted]), baseline);
  assert.equal(grown.length, 1);
  assert.equal(grown[0].rule, 'engine-to-modules');
});

test('--base fails closed: an unknown ref or a non-ref argument throws; only a ref without the baseline file is "nothing to compare"', () => {
  const root = path.resolve(__dirname, '..');
  assert.throws(() => check.readBaselineAt('origin/does-not-exist-untangle', root), /--base: git show .* failed/);
  assert.throws(() => check.readBaselineAt('--output=/tmp/x', root), /not a plain git ref/);
  assert.throws(() => check.readBaselineAt('HEAD;rm -rf', root), /not a plain git ref/);
  // The root commit predates the baseline file: a real ref without the file is the one "nothing to compare" case.
  const { execFileSync } = require('node:child_process');
  const firstCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n')[0];
  assert.equal(check.readBaselineAt(firstCommit, root), null);
  // main() throws, and the CLI wrapper turns that into exit 1: never exit 0 on an unknown base.
  assert.throws(() => check.main(['--base', 'origin/does-not-exist-untangle']), /--base: git show/);
});
