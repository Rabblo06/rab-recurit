#!/usr/bin/env node
'use strict';
/**
 * ci-security "audit": `yarn npm audit --severity high --all --recursive`, with narrow, dated owner exceptions.
 *
 * Every High/Critical advisory fails the job unless tools/npm-audit-decisions.json holds a VALID entry for it. An entry
 * is a last resort for an advisory NOTHING fixes (the normal fix is an upgrade or a root package.json `resolutions`
 * override documented in its "//resolutions" note). It is NOT an ignore list:
 *   - scope: exactly ONE GHSA id and ONE exact package name; decision `accepted-risk` only;
 *   - it links the owner's written decision (owner_decision_ref = an issue/PR of this repository, decided_by,
 *     decided_on) and states the reason and the drop condition (`reason`, `drop_when`);
 *   - expiry: at most 30 days after decided_on; an expired, incomplete, over-long or duplicate entry fails the job;
 *   - it lapses the day a fix ships: the job fails if the GitHub advisory has a `first_patched_version`, or if the
 *     registry has a release in ANY major that is outside the vulnerable range and newer than an installed version;
 *   - dev/build dependencies only: the job fails if the package is in the PRODUCTION closure, i.e. reachable in
 *     yarn.lock from the `dependencies`/`optionalDependencies` of a shipped workspace (the same list as
 *     tools/check-licences.mjs), including yarn-injected dependencies such as `node-gyp: latest`, minus the packages
 *     the runtime image prunes (`RUNTIME_PRUNE` exported by packages/rab-docker/rab/runtime-deps.cjs; a pruned package
 *     and everything reachable only through it are not in the image). No such export = nothing excluded;
 *   - an unused entry is reported (warning) so it can be removed.
 * Fails closed: an audit that exits non-zero without a parseable report, an unparseable line, a failed registry or
 * advisory lookup, an unresolvable yarn.lock descriptor or a range this file cannot evaluate all fail the job. There is
 * no date override. Set GITHUB_TOKEN for the advisory lookup in CI (rate limit).
 *
 *   node tools/check-npm-audit.cjs        # exit 1 on any undecided High/Critical advisory or invalid entry
 *   node --test tools/check-npm-audit.test.cjs
 */
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const REGISTER = join(__dirname, 'npm-audit-decisions.json');
const RUNTIME_DEPS = join(ROOT, 'packages/rab-docker/rab/runtime-deps.cjs');
const AUDIT_ARGS = [
  'npm',
  'audit',
  '--severity',
  'high',
  '--all',
  '--recursive',
  '--json',
];
/** First-party workspaces whose production dependencies ship (same list as tools/check-licences.mjs SHIPPED). */
const SHIPPED = [
  'rab-server',
  'rab-worker',
  'rab-front',
  'rab-shared',
  'rab-ui',
  'rab-emails',
  'rab-utils',
];
const MAX_DAYS = 30;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const REF =
  /^https:\/\/github\.com\/Rabblo06\/rab-recurit\/(issues|pull)\/[1-9]\d*($|[/#?])/;
const DAY_MS = 86_400_000;

// --- minimal semver (x.y.z release versions and comparator ranges; anything else is "cannot evaluate") ---
const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** True/false for `<=4.0.7`, `<= 4.0.7`, `>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4`, ...; throws on what it cannot evaluate. */
function inRange(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`cannot evaluate version ${version}`);
  return String(range)
    .split('||')
    .some((alt) => {
      const parts = alt
        .trim()
        .replace(/(<=|>=|<|>|=)\s+/g, '$1')
        .split(/\s+/)
        .filter(Boolean);
      if (!parts.length) throw new Error(`cannot evaluate range "${range}"`);
      return parts.every((p) => {
        const m = /^(<=|>=|<|>|=)?(.+)$/.exec(p);
        const bound = parseVersion(m[2]);
        if (!bound) throw new Error(`cannot evaluate range "${range}"`);
        const c = cmp(v, bound);
        return {
          '<': c < 0,
          '<=': c <= 0,
          '>': c > 0,
          '>=': c >= 0,
          '=': c === 0,
        }[m[1] || '='];
      });
    });
}

/**
 * Why the exception has lapsed because a fix exists, or null. `advisory` is the GitHub advisory object
 * (GET /advisories/{ghsa}); `published` the registry's version list.
 */
function fixShipped(pkg, treeVersions, vulnerableRange, published, advisory) {
  const vulns =
    (advisory &&
      Array.isArray(advisory.vulnerabilities) &&
      advisory.vulnerabilities) ||
    null;
  if (!vulns) throw new Error('advisory has no vulnerabilities list');
  const mine = vulns.filter((v) => v && v.package && v.package.name === pkg);
  if (!mine.length) throw new Error(`advisory does not list package ${pkg}`);
  const patched = mine.map((v) => v.first_patched_version).filter(Boolean);
  if (patched.length)
    return `the advisory now has first_patched_version ${patched.join(', ')}`;
  const trees = treeVersions.map((t) => {
    const p = parseVersion(t);
    if (!p) throw new Error(`cannot evaluate tree version ${t}`);
    return p;
  });
  const fixes = published.filter((pv) => {
    const p = parseVersion(pv); // prereleases are not fixes
    return (
      p && trees.some((t) => cmp(p, t) > 0) && !inRange(pv, vulnerableRange)
    );
  });
  return fixes.length
    ? `non-vulnerable release(s) on the registry: ${fixes.join(', ')}`
    : null;
}

// --- production closure from yarn.lock ---
/**
 * Chains from a shipped workspace's production dependencies to `target` in yarn.lock (breadth-first: one shortest
 * chain per resolved version of `target`; empty = not in the production closure), not descending into `prune`d
 * packages. `lock` is the parsed yarn.lock, `workspaces` maps package name -> manifest for every workspace, `shipped`
 * lists the shipped workspace names, `resolutions` is the root manifest's.
 * Throws on a descriptor it cannot resolve (fail closed).
 */
function productionPaths({
  lock,
  workspaces,
  shipped,
  resolutions = {},
  prune = [],
  target,
}) {
  const byDesc = new Map();
  for (const [k, v] of Object.entries(lock)) {
    if (k === '__metadata') continue;
    for (const d of k.split(/,\s*/)) byDesc.set(d.trim(), v);
  }
  const norm = (n, r) => (/^[a-z]+:/.test(r) ? `${n}@${r}` : `${n}@npm:${r}`);
  const nameOf = (resolution) =>
    resolution.slice(0, resolution.indexOf('@', 1));
  const resolve = (parent, n, r) => {
    const e = byDesc.get(norm(n, String(r)));
    if (e) return e;
    const override = resolutions[`${parent}/${n}`] ?? resolutions[n];
    const o = override !== undefined && byDesc.get(norm(n, String(override)));
    if (o) return o;
    throw new Error(`yarn.lock has no entry for ${n}@${r} (from ${parent})`);
  };
  const pruned = new Set(prune);
  const paths = [];
  const seen = new Set();
  const queue = [];
  const seenWs = new Set();
  const addWorkspace = (name, chain) => {
    if (seenWs.has(name)) return;
    seenWs.add(name);
    const m = workspaces.get(name);
    if (!m) throw new Error(`workspace ${name} not found`);
    for (const [n, r] of Object.entries({
      ...(m.dependencies || {}),
      ...(m.optionalDependencies || {}),
    })) {
      if (String(r).startsWith('workspace:')) addWorkspace(n, [...chain, n]);
      else if (!pruned.has(n)) queue.push([resolve(name, n, r), [...chain, n]]);
    }
  };
  for (const s of shipped) addWorkspace(s, [s]);
  while (queue.length) {
    const [e, chain] = queue.shift();
    if (seen.has(e.resolution)) continue;
    seen.add(e.resolution);
    const name = nameOf(e.resolution);
    const here = [
      ...chain.slice(0, -1),
      e.resolution.replace(/@npm:/, '@').replace(/@patch:.*$/, ''),
    ];
    if (name === target) {
      paths.push(here.join(' > '));
      continue;
    }
    for (const [n, r] of Object.entries(e.dependencies || {})) {
      if (!pruned.has(n)) queue.push([resolve(name, n, r), [...here, n]]);
    }
  }
  return paths;
}

// --- register ---
const isoDate = (s) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    ? Date.parse(`${s}T00:00:00Z`)
    : null;
const text = (s, min = 1) => typeof s === 'string' && s.trim().length >= min;

/** Returns { valid: Map<id, entry>, errors: string[] }. `today` is a YYYY-MM-DD string (UTC). */
function validateRegister(register, today) {
  const errors = [];
  const valid = new Map();
  if (
    !register ||
    register.schema !== 2 ||
    !Array.isArray(register.decisions)
  ) {
    return {
      valid,
      errors: [
        'npm-audit-decisions.json: expected { "schema": 2, "decisions": [...] }',
      ],
    };
  }
  const now = isoDate(today);
  const ids = new Set();
  for (const [i, d] of register.decisions.entries()) {
    const where = `decision[${i}] ${d && d.id ? d.id : '(no id)'}`;
    const bad = (msg) => errors.push(`${where}: ${msg}`);
    if (!d || typeof d !== 'object') {
      bad('not an object');
      continue;
    }
    const before = errors.length;
    if (typeof d.id !== 'string' || !GHSA.test(d.id))
      bad('id must be exactly one GHSA id');
    if (ids.has(d.id)) bad('duplicate id');
    ids.add(d.id);
    if ('packages' in d)
      bad('one package per entry: use "package", not "packages"');
    if (!text(d.package) || /[\s*?,]/.test(d.package))
      bad('package must be exactly one exact package name');
    if (d.decision !== 'accepted-risk') bad('decision must be accepted-risk');
    if (!text(d.owner_decision_ref) || !REF.test(d.owner_decision_ref)) {
      bad(
        'owner_decision_ref must link the owner decision (issue or PR in this repository)',
      );
    }
    if (!text(d.decided_by)) bad('decided_by is required');
    if (!text(d.reason, 40))
      bad(
        'reason (why no fix and why not reachable in production) is required',
      );
    if (!text(d.drop_when, 20))
      bad('drop_when (the condition to remove the entry) is required');
    const on = isoDate(d.decided_on);
    const exp = isoDate(d.expires);
    if (on === null) bad('decided_on must be YYYY-MM-DD');
    if (exp === null) bad('expires must be YYYY-MM-DD');
    if (on !== null && exp !== null) {
      if (exp <= on) bad('expires must be after decided_on');
      if ((exp - on) / DAY_MS > MAX_DAYS)
        bad(`expires is more than ${MAX_DAYS} days after decided_on`);
      if (on > now) bad('decided_on is in the future');
      if (now > exp)
        bad(`EXPIRED on ${d.expires}; renewing needs a new owner decision`);
    }
    if (errors.length === before) valid.set(d.id, d);
  }
  return { valid, errors };
}

/** Parses `yarn npm audit --json` NDJSON. Throws on a line that is not a report object (fail closed). */
function parseAudit(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        throw new Error(`unparseable audit output line: ${line.slice(0, 200)}`);
      }
      if (
        !o ||
        typeof o.value !== 'string' ||
        !o.children ||
        typeof o.children !== 'object'
      ) {
        throw new Error(`unexpected audit output line: ${line.slice(0, 200)}`);
      }
      const c = o.children;
      const ghsa = /GHSA(-[23456789cfghjmpqrvwx]{4}){3}/.exec(
        String(c.URL || ''),
      );
      return {
        pkg: o.value,
        id: ghsa ? ghsa[0] : null,
        url: c.URL || '',
        issue: c.Issue || '',
        severity: c.Severity || '',
        range: c['Vulnerable Versions'] || '',
        treeVersions: Array.isArray(c['Tree Versions'])
          ? c['Tree Versions']
          : [],
      };
    });
}

/**
 * Verdict per finding. `ctx` supplies lookups, each of which may throw (the finding is then undecided):
 *   published(pkg) -> registry versions; advisory(ghsa) -> GitHub advisory; production(pkg) -> production chains.
 * Returns { undecided, decided, unused }.
 */
function evaluate(findings, valid, ctx) {
  const undecided = [];
  const decided = [];
  const used = new Set();
  for (const f of findings) {
    const d = f.id ? valid.get(f.id) : undefined;
    if (!d || d.package !== f.pkg) {
      undecided.push({ ...f, reason: 'no owner decision' });
      continue;
    }
    used.add(d.id);
    let fix;
    let prod;
    try {
      fix = fixShipped(
        f.pkg,
        f.treeVersions,
        f.range,
        ctx.published(f.pkg),
        ctx.advisory(f.id),
      );
      prod = ctx.production(f.pkg);
    } catch (e) {
      undecided.push({
        ...f,
        reason: `decision cannot be applied: ${e.message}`,
      });
      continue;
    }
    if (fix) {
      undecided.push({
        ...f,
        reason: `a FIX EXISTS (${fix}): the exception has lapsed, upgrade or add a resolution`,
      });
      continue;
    }
    if (prod.length) {
      undecided.push({
        ...f,
        reason: `in the PRODUCTION closure, the exception covers dev/build dependencies only:\n    ${prod.join('\n    ')}`,
      });
      continue;
    }
    decided.push({ ...f, decision: d });
  }
  const unused = [...valid.keys()].filter((id) => !used.has(id));
  return { undecided, decided, unused };
}

function yarn(args) {
  return spawnSync('yarn', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
}

function publishedVersions(pkg) {
  const r = yarn(['npm', 'info', pkg, '--fields', 'versions', '--json']);
  if (r.status !== 0)
    throw new Error(
      `yarn npm info ${pkg} failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`,
    );
  const versions = JSON.parse(r.stdout).versions;
  if (!Array.isArray(versions) || !versions.length)
    throw new Error(`yarn npm info ${pkg}: no versions`);
  return versions;
}

async function fetchAdvisory(id) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ci-security-audit',
  };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/advisories/${id}`, {
    headers,
  });
  if (!res.ok) throw new Error(`GitHub advisory ${id}: HTTP ${res.status}`);
  return res.json();
}

/** RUNTIME_PRUNE from runtime-deps.cjs, read in a child process (requiring it must not run its CLI here). */
function runtimePrune() {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m&&m.RUNTIME_PRUNE))',
      RUNTIME_DEPS,
    ],
    { encoding: 'utf8' },
  );
  let list;
  try {
    list = r.status === 0 ? JSON.parse(r.stdout) : undefined;
  } catch {
    list = undefined;
  }
  if (Array.isArray(list) && list.every((n) => typeof n === 'string' && n))
    return { list, note: null };
  return {
    list: [],
    note: 'runtime-deps.cjs exports no RUNTIME_PRUNE list: nothing is excluded from the production closure',
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { valid, errors } = validateRegister(
    JSON.parse(readFileSync(REGISTER, 'utf8')),
    today,
  );

  const r = yarn(AUDIT_ARGS);
  let findings;
  try {
    findings = parseAudit(r.stdout);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
  if (r.status !== 0 && findings.length === 0) {
    console.error(
      `::error::yarn npm audit exited ${r.status} without a report:\n${r.stdout}\n${r.stderr}`,
    );
    process.exit(1);
  }

  // Lookups are done only for findings that have an entry; each failure is kept and fails that finding.
  const memo = (fn) => {
    const cache = new Map();
    return (k) => {
      if (!cache.has(k)) {
        try {
          cache.set(k, { v: fn(k) });
        } catch (e) {
          cache.set(k, { e });
        }
      }
      const c = cache.get(k);
      if (c.e) throw c.e;
      return c.v;
    };
  };
  const advisories = new Map();
  for (const f of findings) {
    if (f.id && valid.has(f.id) && !advisories.has(f.id)) {
      advisories.set(
        f.id,
        await fetchAdvisory(f.id).then(
          (v) => ({ v }),
          (e) => ({ e }),
        ),
      );
    }
  }
  const prune = runtimePrune();
  if (prune.note && findings.some((f) => f.id && valid.has(f.id)))
    console.log(`note: ${prune.note}`);
  const production = memo((pkg) => {
    const { parse } = require('yaml');
    const rootManifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );
    const workspaces = new Map();
    for (const ws of rootManifest.workspaces.packages) {
      const m = JSON.parse(
        readFileSync(join(ROOT, ws, 'package.json'), 'utf8'),
      );
      workspaces.set(m.name, m);
    }
    const shipped = SHIPPED.map(
      (dir) =>
        JSON.parse(
          readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8'),
        ).name,
    );
    return productionPaths({
      lock: parse(readFileSync(join(ROOT, 'yarn.lock'), 'utf8')),
      workspaces,
      shipped,
      resolutions: rootManifest.resolutions || {},
      prune: prune.list,
      target: pkg,
    });
  });
  const { undecided, decided, unused } = evaluate(findings, valid, {
    published: memo(publishedVersions),
    advisory: (id) => {
      const a = advisories.get(id);
      if (!a) throw new Error(`advisory ${id} was not looked up`);
      if (a.e) throw a.e;
      return a.v;
    },
    production,
  });

  for (const f of decided) {
    console.log(
      `decided (accepted-risk, dev/build only, expires ${f.decision.expires}): ${f.id} ${f.pkg} ${f.treeVersions.join(', ')} [${f.severity}] ${f.issue}`,
    );
  }
  for (const id of unused)
    console.log(
      `::warning::npm-audit-decisions.json: ${id} matches no current finding; remove it`,
    );
  for (const e of errors)
    console.error(`::error::npm-audit-decisions.json ${e}`);
  for (const f of undecided) {
    console.error(
      `::error::${f.id || f.url || '(no advisory id)'} ${f.pkg} ${f.treeVersions.join(', ')} [${f.severity}] ${f.issue}: ${f.reason}`,
    );
  }
  console.log(
    `${findings.length} High/Critical finding(s): ${decided.length} decided, ${undecided.length} undecided; ${errors.length} register error(s)`,
  );
  process.exit(undecided.length || errors.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`::error::${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  inRange,
  fixShipped,
  productionPaths,
  validateRegister,
  parseAudit,
  evaluate,
  MAX_DAYS,
};
