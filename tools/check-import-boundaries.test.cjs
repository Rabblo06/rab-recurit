'use strict';
/**
 * Tests for tools/check-import-boundaries.cjs (untangle wave 1 import-boundary ratchet). Node built-ins plus the repo's
 * own `typescript` (the scanner reads TS imports with ts.preProcessFile).
 *   node --test tools/check-import-boundaries.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
  assert.deepEqual(check.compareToBase(base, { 'engine-to-modules': { a: 1 } }, []).grown, []);
  const g = check.compareToBase(base, { 'engine-to-modules': { a: 3, b: 1 }, 'worker-deep-import': { w: 1 } }, []).grown;
  assert.deepEqual(g.map((x) => [x.rule, x.file, x.newKey]), [['engine-to-modules', 'a', false], ['worker-deep-import', 'w', true]]);
});

const AUDIT = 'packages/rab-server/src/engine/core-modules/audit/audit.service.ts';

describeApproved();

function describeApproved() {
  const W = 'worker-deep-import';
  const FILE = 'packages/rab-worker/src/queues/rab-push/push-send.processor.ts';
  const OTHER = 'packages/rab-worker/src/queues/rab-push/push.processors.ts';
  const approved = Object.freeze([
    Object.freeze({ rule: W, file: FILE, from: 10, to: 11, approved: 'owner 2026-11-17', reason: 'test' }),
  ]);
  const base = { [W]: { [FILE]: 10, [OTHER]: 1 } };
  const grownOf = (head, list = approved) => check.compareToBase(base, head, list).grown.map((g) => `${g.rule}:${g.file}:${g.base}->${g.head}`);

  test('approved growth: the exact approved count passes, with no stale approval', () => {
    assert.deepEqual(check.compareToBase(base, { [W]: { [FILE]: 11, [OTHER]: 1 } }, approved), { grown: [], staleApproved: [], used: [approved[0]] });
  });

  test('approved growth: one more than `to` fails', () => {
    assert.deepEqual(grownOf({ [W]: { [FILE]: 12, [OTHER]: 1 } }), [`${W}:${FILE}:10->12`]);
  });

  test('approved growth: an unlisted file growing still fails', () => {
    assert.deepEqual(grownOf({ [W]: { [FILE]: 11, [OTHER]: 2 } }), [`${W}:${OTHER}:1->2`]);
    assert.deepEqual(grownOf({ [W]: { [FILE]: 10, [OTHER]: 1, 'packages/rab-worker/src/new.ts': 1 } }), [`${W}:packages/rab-worker/src/new.ts:0->1`]);
  });

  test('approved growth: the same file under a different rule still fails', () => {
    const head = { 'engine-to-modules': { [FILE]: 1 }, [W]: { [FILE]: 10, [OTHER]: 1 } };
    assert.deepEqual(grownOf(head), [`engine-to-modules:${FILE}:0->1`]);
  });

  test('approved growth: a base count other than `from` fails, and the approval is reported stale', () => {
    const otherBase = { [W]: { [FILE]: 9, [OTHER]: 1 } };
    const r = check.compareToBase(otherBase, { [W]: { [FILE]: 11, [OTHER]: 1 } }, approved);
    assert.deepEqual(r.grown.map((g) => `${g.file}:${g.base}->${g.head}`), [`${FILE}:9->11`]);
    assert.deepEqual(r.staleApproved.map((a) => `${a.file}:${a.from}:${a.base}`), [`${FILE}:10:9`]);
    // Once the growth has merged (base == to), the approval is stale too: it must be deleted.
    const merged = check.compareToBase({ [W]: { [FILE]: 11, [OTHER]: 1 } }, { [W]: { [FILE]: 11, [OTHER]: 1 } }, approved);
    assert.deepEqual(merged.grown, []);
    assert.equal(merged.staleApproved.length, 1);
  });

  test('approved growth: a consumed entry comes back to life if the base count returns to `from`, which is why stale must fail', () => {
    // Base already at `to` (the using PR merged): the approval no longer matches anything and is reported stale.
    const atTo = check.compareToBase({ [W]: { [FILE]: 11, [OTHER]: 1 } }, { [W]: { [FILE]: 11, [OTHER]: 1 } }, approved);
    assert.deepEqual(atTo, { grown: [], staleApproved: [{ ...approved[0], base: 11 }], used: [] });
    // Base back at `from` (a later PR removed that import again): the same entry matches once more and would let
    // another PR re-add the edge. Only failing STALE at the earlier step forces the entry out before that can happen.
    const backAtFrom = check.compareToBase({ [W]: { [FILE]: 10, [OTHER]: 1 } }, { [W]: { [FILE]: 11, [OTHER]: 1 } }, approved);
    assert.deepEqual(backAtFrom, { grown: [], staleApproved: [], used: [approved[0]] });
  });

  test('approved growth: partial use fails (from 10, to 12, head 11 has grown)', () => {
    const wide = [{ rule: W, file: FILE, from: 10, to: 12, approved: 'owner 2026-11-17', reason: 'test' }];
    const r = check.compareToBase(base, { [W]: { [FILE]: 11, [OTHER]: 1 } }, wide);
    assert.deepEqual(r.grown.map((g) => `${g.rule}:${g.file}:${g.base}->${g.head}`), [`${W}:${FILE}:10->11`]);
    assert.deepEqual(r.staleApproved, []);
  });

  test('approved growth: from 0 means the file has no entry at the base', () => {
    const NEW = 'packages/rab-worker/src/new.ts';
    const zero = [{ rule: W, file: NEW, from: 0, to: 1, approved: 'owner 2026-11-17', reason: 'test' }];
    assert.deepEqual(check.compareToBase(base, { [W]: { [FILE]: 10, [OTHER]: 1, [NEW]: 1 } }, zero), { grown: [], staleApproved: [], used: [zero[0]] });
  });

  test('validateApprovedGrowth refuses malformed or undated approvals; the shipped approvals file is valid', () => {
    const ok = { rule: W, file: FILE, from: 10, to: 11, approved: 'owner 2026-11-17', reason: 'r' };
    const shipped = check.readApprovals(path.resolve(__dirname, '..'));
    assert.doesNotThrow(() => check.validateApprovedGrowth(shipped));
    assert.ok(Object.isFrozen(shipped) && shipped.every((e) => Object.isFrozen(e)));
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, approved: 'owner' }]), /owner YYYY-MM-DD/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, rule: 'nope' }]), /unknown rule/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, to: 10 }]), /above from/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, reason: ' ' }]), /reason is required/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, extra: 1 }]), /keys must be exactly/);
    assert.throws(() => check.validateApprovedGrowth([ok, ok]), /duplicate/);
    assert.throws(() => check.compareToBase(base, base, [{ ...ok, to: 'x' }]), /above from/);
    assert.throws(() => check.compareToBase(base, base, undefined), /must be an array/);
    // `file` must be a production file the check scans.
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, file: 'tools/x.ts' }]), /production file the check scans/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, file: 'packages/rab-worker/src/x.spec.ts' }]), /production file the check scans/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, file: 'packages/rab-worker/src/../../tools/x.ts' }]), /production file the check scans/);
  });

  test('approval target: optional, and must be an edge of the entry\'s rule from its file', () => {
    const ok = { rule: W, file: FILE, from: 10, to: 11, approved: 'owner 2026-11-17', reason: 'r' };
    assert.doesNotThrow(() => check.validateApprovedGrowth([{ ...ok, target: AUDIT }]));
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, target: 'packages/rab-server/src/engine/worker-shared/queue-registry.ts' }]), /target must be/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, target: 'packages/rab-shared/src/money.ts' }]), /target must be/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, target: 'packages/rab-server/src/../src/x.ts' }]), /target must be/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, target: '' }]), /target must be/);
    assert.throws(() => check.validateApprovedGrowth([{ ...ok, target: 7 }]), /target must be/);
  });

  test('approval target (tree check): an approved count reached through a different import fails', () => {
    const a = { rule: W, file: FILE, from: 10, to: 11, approved: 'owner 2026-11-17', reason: 'r', target: AUDIT };
    const edge = (target) => ({ rule: W, file: FILE, target, spec: target });
    const others = Array.from({ length: 10 }, (_, i) => edge(`packages/rab-server/src/modules/m${i}.ts`));
    const viaTarget = [...others, edge(AUDIT)];
    const viaOther = [...others, edge('packages/rab-server/src/modules/other.ts')];
    assert.deepEqual(check.checkApprovalTargets([a], viaTarget, check.countsOf(viaTarget)), []);
    assert.deepEqual(check.checkApprovalTargets([a], viaOther, check.countsOf(viaOther)).map((m) => `${m.file}:${m.current}`), [`${FILE}:11`]);
    // Not yet used (count still at `from`): nothing to assert. No target: nothing to assert.
    assert.deepEqual(check.checkApprovalTargets([a], others, check.countsOf(others)), []);
    const { target, ...untargeted } = a;
    assert.equal(target, AUDIT);
    assert.deepEqual(check.checkApprovalTargets([untargeted], viaOther, check.countsOf(viaOther)), []);
  });
}

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

const REPO = path.resolve(__dirname, '..');
const firstCommit = () => execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n')[0];

test('--base fails closed: an unknown ref or a non-ref argument throws; only a ref without the baseline file is "nothing to compare"', () => {
  assert.throws(() => check.readBaselineAt('origin/does-not-exist-untangle', REPO), /--base: git show .* failed/);
  assert.throws(() => check.readBaselineAt('--output=/tmp/x', REPO), /not a plain git ref/);
  assert.throws(() => check.readBaselineAt('HEAD;rm -rf', REPO), /not a plain git ref/);
  assert.throws(() => check.readApprovalsAt('origin/does-not-exist-untangle', REPO), /--base: git show .* failed/);
  // The root commit predates both files: a real ref without the file is the one "absent" case.
  assert.equal(check.readBaselineAt(firstCommit(), REPO), null);
  assert.deepEqual(check.readApprovalsAt(firstCommit(), REPO), []);
  // main() throws, and the CLI wrapper turns that into exit 1: never exit 0 on an unknown base.
  assert.throws(() => check.main(['--base', 'origin/does-not-exist-untangle']), /--base: git (?:merge-base|show) .*failed/);
});

test('--base refs: a plain name with ~N / ^N ancestry suffixes is accepted; every other revision syntax is refused', () => {
  for (const ref of ['HEAD~0', 'HEAD^0', 'HEAD~1', 'origin/main^2', 'HEAD~', 'HEAD^', 'release/0.6.0']) assert.equal(check.assertPlainRef(ref), ref);
  for (const ref of ['^HEAD', '~HEAD', 'HEAD^{tree}', 'HEAD@{1}', '@{-1}', 'main..HEAD', 'main...HEAD', 'HEAD:tools/x', 'HEAD~1x', '-HEAD', 'a b', '', 'HEAD^!']) {
    assert.throws(() => check.assertPlainRef(ref), /not a plain git ref/, ref);
  }
  assert.deepEqual(check.readBaselineAt('HEAD~0', REPO), check.readBaselineAt('HEAD', REPO));
  // An ancestry step past the root commit is an unknown revision: it throws, it never reads as "no baseline".
  assert.throws(() => check.readBaselineAt(`${firstCommit()}~1`, REPO), /--base: git show .* failed/);
});

test('git runs with LC_ALL=C and no LANGUAGE, so "does not exist in" is matched whatever the caller\'s locale', () => {
  const env = check.gitEnv();
  assert.equal(env.LC_ALL, 'C');
  assert.equal('LANGUAGE' in env, false);
  const keys = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', LANGUAGE: 'de' });
  try {
    assert.equal(check.readBaselineAt(firstCommit(), REPO), null);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('approvalsChangedWithBaselines: the approvals file together with any tools/*.baseline.json', () => {
  const A = check.APPROVALS_REL;
  assert.deepEqual(check.approvalsChangedWithBaselines([A]), []);
  assert.deepEqual(check.approvalsChangedWithBaselines([check.BASELINE_REL, 'packages/x.ts']), []);
  assert.deepEqual(check.approvalsChangedWithBaselines([A, check.BASELINE_REL]), [check.BASELINE_REL]);
  assert.deepEqual(check.approvalsChangedWithBaselines([A, 'tools/workspace-table-qualified.baseline.json', 'tools/x.cjs']), ['tools/workspace-table-qualified.baseline.json']);
});

test('parseApprovals refuses a malformed document', () => {
  assert.throws(() => check.parseApprovals('{', 'x'), /not valid JSON/);
  assert.throws(() => check.parseApprovals('[]', 'x'), /"approved" array/);
  assert.throws(() => check.parseApprovals('{}', 'x'), /must be an array/);
  assert.throws(() => check.parseApprovals('{"approved":[],"extra":1}', 'x'), /unknown key/);
  assert.deepEqual(check.parseApprovals('{"_comment":["c"],"approved":[]}', 'x'), []);
});

// ---- End to end, in a throwaway git repository (main() with { root }): the base ref decides. ----

const WF = 'packages/rab-worker/src/queues/q/x.job.ts';
const T_OLD = 'packages/rab-server/src/modules/a/a.service.ts';
const T_OTHER = 'packages/rab-server/src/engine/core-modules/other/other.service.ts';
const APPROVAL = Object.freeze({ rule: 'worker-deep-import', file: WF, from: 1, to: 2, target: AUDIT, approved: 'owner 2026-11-17', reason: 'fixture' });
const importOf = (target) => `import '@rab/server/${target.slice('packages/rab-server/src/'.length).replace(/\.ts$/, '')}';\n`;
const baselineDoc = (n) => `${JSON.stringify({ rules: { 'worker-deep-import': { [WF]: n } } }, null, 2)}\n`;
const approvalsDoc = (list) => `${JSON.stringify({ approved: list }, null, 2)}\n`;

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-boundaries-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A throwaway repository: identity, signing and line endings are pinned so the user's git config cannot change it.
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  git('init', '-q', '--initial-branch=main');
  return { dir, git, write, commit };
}

/** Base commit on `main`: WF has one worker-deep-import edge; the approvals file holds `baseApprovals`. Then branch `pr`. */
function seed(t, baseApprovals, baseImports = [T_OLD]) {
  const r = fixtureRepo(t);
  for (const f of [T_OLD, AUDIT, T_OTHER]) r.write(f, 'export const x = 1;\n');
  r.write(WF, baseImports.map(importOf).join(''));
  r.write(check.BASELINE_REL, baselineDoc(baseImports.length));
  r.write(check.APPROVALS_REL, approvalsDoc(baseApprovals));
  r.commit('base');
  r.git('checkout', '-q', '-b', 'pr');
  return r;
}

function run(argv, root) {
  const out = [];
  const saved = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: check.main(argv, { root }), out: out.join('\n') };
  } finally {
    [console.log, console.error] = saved;
  }
}

test('tree check: exit 1 when the baseline file is missing', (t) => {
  const r = fixtureRepo(t);
  const { code, out } = run([], r.dir);
  assert.equal(code, 1);
  assert.match(out, /import-boundaries\.baseline\.json is missing/);
});

test('--base: an approval present only in the head does not let the growth through', (t) => {
  const r = seed(t, []);
  r.write(WF, importOf(T_OLD) + importOf(AUDIT));
  r.write(check.BASELINE_REL, baselineDoc(2));
  r.write(check.APPROVALS_REL, approvalsDoc([APPROVAL]));
  r.commit('approve and use in one PR');
  // The decision uses the base ref's list (empty), not the head's (one entry).
  assert.deepEqual(check.readApprovalsAt('main', r.dir), []);
  assert.equal(check.readApprovals(r.dir).length, 1);
  const { grown } = check.compareToBase(check.readBaselineAt('main', r.dir), check.parseBaseline(baselineDoc(2), 'head'), check.readApprovalsAt('main', r.dir));
  assert.deepEqual(grown.map((g) => `${g.file}:${g.base}->${g.head}`), [`${WF}:1->2`]);
  const { code, out } = run(['--base', 'main'], r.dir);
  assert.equal(code, 1);
  assert.match(out, /GROWN {2}worker-deep-import\s+packages\/rab-worker\/src\/queues\/q\/x\.job\.ts: 1 -> 2/);
  assert.match(out, /0 approval\(s\) in force on main, 0 used/);
});

test('--base: the same approval present on the base lets exactly that growth through', (t) => {
  const r = seed(t, [APPROVAL]);
  r.write(WF, importOf(T_OLD) + importOf(AUDIT));
  r.write(check.BASELINE_REL, baselineDoc(2));
  r.commit('use the approval');
  const base = run(['--base', 'main'], r.dir);
  assert.equal(base.code, 0, base.out);
  assert.match(base.out, /0 grown entries, 0 stale approval\(s\), 1 approval\(s\) in force on main, 1 used, 0 wrong target\(s\)/);
  const tree = run([], r.dir);
  assert.equal(tree.code, 0, tree.out);
});

test('--base: an approval PR that touches no baseline passes, and its entry is not in force until it merges', (t) => {
  const r = seed(t, []);
  r.write(check.APPROVALS_REL, approvalsDoc([APPROVAL]));
  r.commit('approval only');
  const { code, out } = run(['--base', 'main'], r.dir);
  assert.equal(code, 0, out);
  assert.match(out, /0 approval\(s\) in force on main/);
});

test('--base: changing the approvals file together with a baseline fails, even when the base approval matches', (t) => {
  const r = seed(t, [APPROVAL]);
  r.write(WF, importOf(T_OLD) + importOf(AUDIT));
  r.write(check.BASELINE_REL, baselineDoc(2));
  r.write(check.APPROVALS_REL, approvalsDoc([{ ...APPROVAL, reason: 'edited in the using PR' }]));
  r.commit('use and edit');
  const { code, out } = run(['--base', 'main'], r.dir);
  assert.equal(code, 1);
  assert.match(out, /CHANGED TOGETHER tools\/import-boundaries\.approved\.json and tools\/import-boundaries\.baseline\.json/);
  assert.doesNotMatch(out, /GROWN/);
  // Uncommitted edits to tracked files count too (the diff is taken against the working tree).
  const r2 = seed(t, [APPROVAL]);
  r2.write(check.APPROVALS_REL, approvalsDoc([]));
  r2.write(check.BASELINE_REL, `${baselineDoc(1)}\n`);
  const uncommitted = run(['--base', 'main'], r2.dir);
  assert.equal(uncommitted.code, 1);
  assert.match(uncommitted.out, /CHANGED TOGETHER/);
});

test('--base and tree check: an approved count reached through a different import fails', (t) => {
  const r = seed(t, [APPROVAL]);
  r.write(WF, importOf(T_OLD) + importOf(T_OTHER));
  r.write(check.BASELINE_REL, baselineDoc(2));
  r.commit('import something else');
  const base = run(['--base', 'main'], r.dir);
  assert.equal(base.code, 1);
  assert.match(base.out, /WRONG TARGET worker-deep-import\s+packages\/rab-worker\/src\/queues\/q\/x\.job\.ts: approved 1 -> 2 for .*audit\.service\.ts, but the file adds 0 edge\(s\) to it/);
  const tree = run([], r.dir);
  assert.equal(tree.code, 1);
  assert.match(tree.out, /TARGET MISSING worker-deep-import\s+packages\/rab-worker\/src\/queues\/q\/x\.job\.ts/);
});

test('--base: a file that already imported the target at the base cannot fill the slot with another import', (t) => {
  const r = seed(t, [APPROVAL], [AUDIT]);
  r.write(WF, importOf(AUDIT) + importOf(T_OTHER));
  r.write(check.BASELINE_REL, baselineDoc(2));
  r.commit('import something else next to the target');
  // The tree check only sees that an edge to the target exists; --base counts the edges the PR adds to it.
  assert.equal(run([], r.dir).code, 0);
  const base = run(['--base', 'main'], r.dir);
  assert.equal(base.code, 1);
  assert.match(base.out, /WRONG TARGET .* adds 0 edge\(s\) to it/);
});
