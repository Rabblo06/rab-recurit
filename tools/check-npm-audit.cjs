#!/usr/bin/env node
'use strict';
/**
 * ci-security "audit": `yarn npm audit --severity high --all --recursive`, with narrow, dated owner exceptions.
 *
 * Every High/Critical advisory fails the job unless tools/npm-audit-decisions.json holds a VALID entry for it. An entry
 * is a last resort for an advisory NOTHING fixes (the normal fix is an upgrade or a root package.json `resolutions`
 * override documented in its "//resolutions" note). It is NOT an ignore list:
 *   - scope: exactly ONE GHSA id and ONE exact package name; decision `accepted-risk` only;
 *   - severity: the entry records the advisory severity it decided (`high` or `critical`); a finding rated ABOVE it
 *     is not covered (a re-scored advisory needs a new owner decision);
 *   - it links the owner's written decision (owner_decision_ref = an issue/PR of this repository, decided_by,
 *     decided_on) and states the reason and the drop condition (`reason`, `drop_when`);
 *   - expiry: at most 30 days after decided_on; an expired, incomplete, over-long or duplicate entry fails the job;
 *     a date must be a real calendar day (2026-02-30 is refused); 7 days or fewer left prints a warning;
 *   - it lapses the day a fix ships: the job fails if the GitHub advisory has a `first_patched_version`, or if the
 *     registry has a release in ANY major that is outside the vulnerable range and newer than an installed version;
 *   - dev/build dependencies only: the job fails if the package is in the PRODUCTION closure, i.e. reachable in
 *     yarn.lock from the `dependencies`/`optionalDependencies` of a shipped workspace (the same list as
 *     tools/check-licences.mjs), including yarn-injected dependencies such as `node-gyp: latest`, minus the packages
 *     the runtime image prunes (`RUNTIME_PRUNE` exported by packages/rab-docker/rab/runtime-deps.cjs; a pruned package
 *     and everything reachable only through it are not in the image). No such export = nothing excluded;
 *   - a finding whose report has no `Tree Versions` cannot be evaluated and is never covered;
 *   - an unused entry is reported (warning) so it can be removed.
 *
 * Which register decides (review F1 of #229, the pattern of tools/check-import-boundaries.cjs since #225):
 *   - `--base <ref>` (every pull request): the decisions are read FROM THE BASE REF with
 *     `git show <ref>:tools/npm-audit-decisions.json`, never from the PR's own copy, so a PR cannot approve itself.
 *     Fail closed: an unknown ref, a shallow clone or any other git failure throws; only "path does not exist in
 *     <ref>" means "no decisions". The head copy is validated too (a malformed file fails the PR that introduces it).
 *   - Decision-only PR: when the diff from the merge-base with <ref> touches the register and nothing else except
 *     THREAT-MODEL.md, the HEAD decisions are used (that is how an entry is added, renewed or removed), and every
 *     entry that is new or changed against the merge-base with <ref> must have owner_decision_ref equal to this PR's URL
 *     (pull_request.html_url in $GITHUB_EVENT_PATH): the owner's merge of that PR is the decision.
 *   - CHANGED TOGETHER: --base fails when that diff ADDS OR CHANGES a register entry together with yarn.lock, any
 *     package.json, .yarnrc.yml, anything under .yarn/ or .github/actions/yarn-install/, this tool,
 *     packages/rab-docker/rab/runtime-deps.cjs (RUNTIME_PRUNE), .github/workflows/ci-security.yaml or
 *     .github/workflows/npm-audit-weekly.yaml. A pure removal may go with anything (e.g. the upgrade that fixes it).
 *   - Outside a decision-only PR, a register entry that is new or changed against the merge-base fails (it would be
 *     in force from the next PR on without having been decided in its own PR); removing an entry is allowed anywhere.
 *   - No --base (push to main, the weekly schedule, a local run): the checked-out register decides. In a
 *     `pull_request` event (GITHUB_EVENT_NAME) running without --base is refused.
 *   - git runs with LC_ALL=C (LANGUAGE unset) so "does not exist in" is matched in English; --base takes a plain ref
 *     plus `~N` / `^N` suffixes only, and git runs without a shell.
 *
 * Before auditing, the job fails unless `yarn config get npmAuditIgnoreAdvisories --json` and
 * `yarn config get npmAuditExcludePackages --json` are both `[]` (an ignore list would hide advisories with no owner,
 * no scope and no expiry), `npmAuditRegistry` is unset and `npmRegistryServer` is yarn's or npm's default registry,
 * and no YARN_NPM_AUDIT_* or YARN_NPM_REGISTRY_SERVER variable is set (an audit pointed at a server that reports
 * nothing would pass). The connection is pinned too: httpsProxy, httpProxy and httpsCaFilePath unset, enableStrictSsl
 * true, networkSettings empty, no plugin beyond yarn's built-ins, and no YARN_HTTPS_PROXY, YARN_HTTP_PROXY,
 * NODE_EXTRA_CA_CERTS or NODE_TLS_REJECT_UNAUTHORIZED=0. (`caFilePath` is not a yarn 4 setting: yarn itself refuses
 * to run when it is set, which fails these checks.) Any argument other than --base <ref> / --fail-on-expiring exits 1. `--fail-on-expiring` (the weekly run) also fails when an entry has 7 days or fewer left.
 * Fails closed: yarn that cannot be spawned, is killed by a signal or exits outside {0, 1} for the audit; an audit
 * that exits non-zero without a parseable report; an unparseable line; a failed registry or advisory lookup; an
 * unresolvable yarn.lock descriptor or a range this file cannot evaluate. There is no date override. Set GITHUB_TOKEN
 * for the advisory lookup in CI (rate limit).
 *
 *   node tools/check-npm-audit.cjs                     # the checked-out register (push to main, schedule, local)
 *   node tools/check-npm-audit.cjs --base origin/main  # a pull request: decisions from the base ref
 *   node tools/check-npm-audit.cjs --fail-on-expiring  # the weekly run: 7 days or fewer left also fails
 *   node --test tools/check-npm-audit.test.cjs
 */
const { spawnSync, execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const REGISTER_REL = 'tools/npm-audit-decisions.json';
const RUNTIME_DEPS_REL = 'packages/rab-docker/rab/runtime-deps.cjs';
const AUDIT_ARGS = [
  'npm',
  'audit',
  '--severity',
  'high',
  '--all',
  '--recursive',
  '--json',
];
/** yarn settings that would silently drop advisories from the audit: both must be empty. */
/** The audit's registry must be yarn's default (an audit pointed at a server that reports nothing passes): G4. */
const DEFAULT_REGISTRIES = [
  'https://registry.yarnpkg.com',
  'https://registry.npmjs.org',
];
const AUDIT_IGNORE_SETTINGS = [
  'npmAuditIgnoreAdvisories',
  'npmAuditExcludePackages',
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
const WARN_DAYS = 7;
/** Severity order of yarn's audit report; an entry may decide `high` or `critical` (the audit runs at high+). */
const SEVERITY_RANK = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});
const ENTRY_SEVERITIES = ['high', 'critical'];
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const REF =
  /^https:\/\/github\.com\/Rabblo06\/rab-recurit\/(issues|pull)\/[1-9]\d*($|[/#?])/;
const PR_URL = /^https:\/\/github\.com\/Rabblo06\/rab-recurit\/pull\/[1-9]\d*$/;
const DAY_MS = 86_400_000;
/** A decision-only PR may change these and nothing else (the register must be among them). */
const DECISION_ONLY_PATHS = new Set([REGISTER_REL, 'THREAT-MODEL.md']);
/** Paths that may never change in the same PR as the register. */
const isChangedTogetherPath = (p) =>
  p === 'yarn.lock' ||
  p === 'package.json' ||
  p.endsWith('/package.json') ||
  p === '.yarnrc.yml' ||
  p.startsWith('.yarn/') ||
  p.startsWith('.github/actions/yarn-install/') ||
  p === 'tools/check-npm-audit.cjs' ||
  p === RUNTIME_DEPS_REL ||
  p === '.github/workflows/ci-security.yaml' ||
  p === '.github/workflows/npm-audit-weekly.yaml';

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
/** Epoch ms of a real calendar day YYYY-MM-DD (UTC), or null. Round-trips, so 2026-02-30 is refused (review F7). */
const isoDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s
    ? ms
    : null;
};
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
  if (now === null) throw new Error(`today is not YYYY-MM-DD: ${today}`);
  const ids = new Set();
  for (const [i, d] of register.decisions.entries()) {
    const where = `decision[${i}] ${d && d.id ? d.id : '(no id)'}`;
    const bad = (msg) => errors.push(`${where}: ${msg}`);
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
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
    if (!ENTRY_SEVERITIES.includes(d.severity))
      bad(
        `severity (the advisory severity the owner decided) must be one of ${ENTRY_SEVERITIES.join(', ')}`,
      );
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
    if (on === null) bad('decided_on must be a real date, YYYY-MM-DD');
    if (exp === null) bad('expires must be a real date, YYYY-MM-DD');
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

/** Valid entries with WARN_DAYS or fewer days left (the expiry day itself counts as 0). */
function expiringSoon(valid, today) {
  const now = isoDate(today);
  const out = [];
  for (const d of valid.values()) {
    const left = Math.round((isoDate(d.expires) - now) / DAY_MS);
    if (left <= WARN_DAYS) out.push({ id: d.id, expires: d.expires, left });
  }
  return out;
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
    if (!f.treeVersions.length) {
      undecided.push({
        ...f,
        reason:
          'cannot evaluate: the audit report has no Tree Versions (no installed version to check a fix against)',
      });
      continue;
    }
    const rank = SEVERITY_RANK[String(f.severity).toLowerCase()];
    if (rank === undefined) {
      undecided.push({
        ...f,
        reason: `cannot evaluate: unknown severity "${f.severity}"`,
      });
      continue;
    }
    if (rank > SEVERITY_RANK[d.severity]) {
      undecided.push({
        ...f,
        reason: `severity ${f.severity} is above the ${d.severity} the owner decided: a re-scored advisory needs a new owner decision`,
      });
      continue;
    }
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

// --- git (fail closed; the same reader as tools/check-import-boundaries.cjs) ---
/** git's environment: LC_ALL=C and no LANGUAGE, so its messages are English whatever the caller's locale. */
function gitEnv(env = process.env) {
  const out = { ...env, LC_ALL: 'C' };
  delete out.LANGUAGE;
  return out;
}

function git(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
}

/** A plain ref name plus optional `~N` / `^N` ancestry suffixes; every other revision syntax is refused. */
const PLAIN_REF = /^[A-Za-z0-9._/-]{1,200}(?:[~^][0-9]{0,4}){0,20}$/;
function assertPlainRef(ref) {
  if (
    typeof ref !== 'string' ||
    !PLAIN_REF.test(ref) ||
    ref.startsWith('-') ||
    ref.includes('..')
  ) {
    throw new Error(`--base: not a plain git ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** `rel` as committed at `ref`, or null ONLY when the ref exists but has no such path. Any other failure throws. */
function gitShowAt(ref, rel, root = ROOT) {
  assertPlainRef(ref);
  try {
    return git(['show', `${ref}:${rel}`], root);
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (/does not exist in|exists on disk, but not in/.test(stderr))
      return null;
    throw new Error(
      `--base: git show ${ref}:${rel} failed: ${stderr.trim().split('\n')[0] || error.message}`,
    );
  }
}

/** The merge-base of `ref` and HEAD (a commit id); throws when there is none (unknown ref, shallow clone). */
function mergeBaseOf(ref, root = ROOT) {
  assertPlainRef(ref);
  try {
    return git(['merge-base', ref, 'HEAD'], root).trim();
  } catch (error) {
    throw new Error(
      `--base: git merge-base ${ref} HEAD failed: ${
        String(error.stderr ?? '')
          .trim()
          .split('\n')[0] || error.message
      }`,
    );
  }
}

/** Paths the checkout (working tree included) changes since its merge-base with `ref`; a rename is a delete + an add. */
function changedSinceBase(ref, root = ROOT) {
  return changedSince(mergeBaseOf(ref, root), root);
}

/** Paths the checkout (working tree included) changes since commit `mergeBase`. */
function changedSince(mergeBase, root = ROOT) {
  return git(
    ['diff', '--name-only', '--no-renames', '-z', mergeBase, '--'],
    root,
  )
    .split('\0')
    .filter(Boolean);
}

function parseRegisterText(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}: not valid JSON (${e.message})`);
  }
}

/** The register as committed at `ref`; an empty register when that ref has no register file. */
function readRegisterAt(ref, root = ROOT) {
  const raw = gitShowAt(ref, REGISTER_REL, root);
  return raw === null
    ? { schema: 2, decisions: [] }
    : parseRegisterText(raw, `${ref}:${REGISTER_REL}`);
}

/** The register changed in the same diff as a CHANGED TOGETHER path ([] when the register is unchanged). */
function registerChangedWith(changed) {
  if (!changed.includes(REGISTER_REL)) return [];
  return changed.filter(isChangedTogetherPath);
}

/** True when the diff changes the register and nothing else except THREAT-MODEL.md. */
const isDecisionOnly = (changed) =>
  changed.includes(REGISTER_REL) &&
  changed.every((p) => DECISION_ONLY_PATHS.has(p));

/** Deterministic JSON (object keys sorted at every level), for deep equality of entries. */
const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

/** Head entries that are new, or differ in any field, against the base register (by id). */
function newOrChangedEntries(baseRegister, headRegister) {
  const base = new Map(
    (Array.isArray(baseRegister && baseRegister.decisions)
      ? baseRegister.decisions
      : []
    ).map((d) => [d && d.id, canonical(d)]),
  );
  return (
    Array.isArray(headRegister && headRegister.decisions)
      ? headRegister.decisions
      : []
  ).filter((d) => base.get(d && d.id) !== canonical(d));
}

/** This pull request's URL from the event payload ($GITHUB_EVENT_PATH); throws when it cannot be established. */
function pullRequestUrl(env) {
  const file = env.GITHUB_EVENT_PATH;
  if (!file)
    throw new Error('GITHUB_EVENT_PATH is not set, so the PR URL is unknown');
  let url;
  try {
    const event = JSON.parse(readFileSync(file, 'utf8'));
    url = event && event.pull_request && event.pull_request.html_url;
  } catch (e) {
    throw new Error(`cannot read the event payload ${file}: ${e.message}`);
  }
  if (typeof url !== 'string' || !PR_URL.test(url))
    throw new Error(
      `the event payload has no pull_request.html_url of this repository (${JSON.stringify(url)})`,
    );
  return url;
}

/**
 * Which register decides, and every register error. Returns { register, source, errors }.
 * `headRaw` is the checkout's register text (null = missing).
 */
function selectRegister({ ref, root, env, today, headRaw }) {
  const errors = [];
  let head = null;
  if (headRaw === null)
    errors.push(`${REGISTER_REL} is missing in the checkout`);
  else {
    try {
      head = parseRegisterText(headRaw, REGISTER_REL);
    } catch (e) {
      errors.push(e.message);
    }
  }
  const headErrors = head
    ? validateRegister(head, today).errors.map((e) => `(head) ${e}`)
    : [];
  if (!ref) {
    return {
      register: head,
      source: 'the checkout (no --base)',
      errors: [...errors, ...headErrors],
    };
  }
  const mergeBase = mergeBaseOf(ref, root); // once: the diff and "what this PR added" both use it
  const changed = changedSince(mergeBase, root);
  const base = readRegisterAt(ref, root);
  // The entries this PR itself adds or changes (against the merge-base). A pure removal is never one of them.
  const added =
    head && changed.includes(REGISTER_REL)
      ? newOrChangedEntries(readRegisterAt(mergeBase, root), head)
      : [];
  // CHANGED TOGETHER binds additions and changes only: removing an entry (e.g. in the PR that upgrades the fix in,
  // as drop_when says) may go with yarn.lock, package.json or anything else.
  if (added.length) {
    for (const p of registerChangedWith(changed)) {
      errors.push(
        `CHANGED TOGETHER ${REGISTER_REL} and ${p}: an owner decision (a new or changed entry) merges in its own PR (register and THREAT-MODEL.md only), never with a dependency, yarn config, tool or workflow change; removing an entry is allowed anywhere`,
      );
    }
  }
  if (isDecisionOnly(changed)) {
    const fresh = added;
    if (fresh.length) {
      let url = null;
      try {
        url = pullRequestUrl(env);
      } catch (e) {
        errors.push(
          `decision-only PR adds or changes ${fresh.map((d) => (d && d.id) || '(no id)').join(', ')} but ${e.message}: cannot verify owner_decision_ref`,
        );
      }
      if (url) {
        for (const d of fresh) {
          if (!d || d.owner_decision_ref !== url) {
            errors.push(
              `decision-only PR: new or changed entry ${(d && d.id) || '(no id)'} must have owner_decision_ref ${url} (this PR; its merge is the owner decision), has ${JSON.stringify(d && d.owner_decision_ref)}`,
            );
          }
        }
      }
    }
    return {
      register: head,
      source: `the head (decision-only PR against ${ref})`,
      errors: [...errors, ...headErrors],
    };
  }
  // G1: outside a decision-only PR the head's new or changed entries are not in force here, but they WOULD be from
  // the next PR on, once merged. So they may only arrive in a decision-only PR (register + THREAT-MODEL.md), where
  // they must cite that PR. Compared with the merge-base (what this PR itself changed); pure removals stay allowed.
  if (added.length) {
    errors.push(
      `${added.map((d) => (d && d.id) || '(no id)').join(', ')} added or changed outside a decision-only PR: a new or changed entry must merge in its own PR (${REGISTER_REL} + THREAT-MODEL.md only) whose owner_decision_ref is that PR; removing an entry is allowed anywhere`,
    );
  }
  const baseErrors =
    headRaw !== null && canonical(base) === canonical(head)
      ? [] // identical: reported once, as (head)
      : validateRegister(base, today).errors.map((e) => `(${ref}) ${e}`);
  return {
    register: base,
    source: `${ref} (base ref; the PR's own copy is not in force)`,
    errors: [...errors, ...baseErrors, ...headErrors],
  };
}

// --- yarn ---
function defaultYarn(root) {
  return (args) =>
    spawnSync('yarn', args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
      cwd: root,
    });
}

/** Why a spawnSync result is a failure (could not run, killed, unexpected exit), or null. */
function spawnFailure(r, okStatuses) {
  if (!r) return 'returned no result';
  if (r.error) return `could not run (${r.error.message || r.error})`;
  if (r.signal) return `was killed by ${r.signal}`;
  if (!okStatuses.includes(r.status)) return `exited ${r.status}`;
  return null;
}

/**
 * Problems with the audit's own configuration (review F3, G4): any ignore list, a registry other than yarn's default
 * (an audit pointed at a server that reports nothing would pass), or a YARN_NPM_AUDIT_* / YARN_NPM_REGISTRY_SERVER
 * variable.
 */
function auditConfigProblems(yarn, env) {
  const problems = [];
  for (const k of Object.keys(env)) {
    if (
      /^YARN_NPM_AUDIT_/i.test(k) ||
      /^(YARN_NPM_REGISTRY_SERVER|YARN_HTTPS_PROXY|YARN_HTTP_PROXY|NODE_EXTRA_CA_CERTS)$/i.test(
        k,
      )
    )
      problems.push(
        `environment variable ${k} is set: the audit must run with yarn's defaults (registry, proxy and CAs)`,
      );
    if (
      /^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(k) &&
      String(env[k]).trim() === '0'
    )
      problems.push(
        `environment variable ${k}=0 disables TLS certificate checks: the audit's registry answer could be forged`,
      );
  }
  /** `yarn config get key --json` parsed as { value }, or undefined after recording a problem. */
  const configGet = (key) => {
    const r = yarn(['config', 'get', key, '--json']);
    const failed = spawnFailure(r, [0]);
    if (failed) {
      problems.push(
        `yarn config get ${key} ${failed}: ${String(r && (r.stderr || r.stdout)).slice(0, 300)}`,
      );
      return undefined;
    }
    const out = String(r.stdout).trim();
    if (out === 'undefined') return { value: undefined }; // yarn prints this for an unset MAP (networkSettings)
    try {
      return { value: JSON.parse(out) };
    } catch {
      problems.push(
        `yarn config get ${key}: unparseable output ${String(r.stdout).slice(0, 200)}`,
      );
      return undefined;
    }
  };
  const auditRegistry = configGet('npmAuditRegistry');
  if (auditRegistry && auditRegistry.value !== null) {
    problems.push(
      `npmAuditRegistry must be unset (yarn's default), is ${JSON.stringify(auditRegistry.value)}: the audit must ask the default registry`,
    );
  }
  const server = configGet('npmRegistryServer');
  if (server && !DEFAULT_REGISTRIES.includes(server.value)) {
    problems.push(
      `npmRegistryServer must be ${DEFAULT_REGISTRIES.join(' or ')}, is ${JSON.stringify(server.value)}: the audit must ask the default registry`,
    );
  }
  // Transport (follow-up to G4): the pinned registry URL is only worth something if the connection to it cannot be
  // redirected or intercepted (a proxy, an extra or replaced CA, TLS checks off, per-host overrides, a plugin).
  for (const key of ['httpsProxy', 'httpProxy', 'httpsCaFilePath']) {
    const got = configGet(key);
    if (got && got.value !== null)
      problems.push(
        `${key} must be unset (yarn's default), is ${JSON.stringify(got.value)}: the audit's connection must not be redirected or re-rooted`,
      );
  }
  const strict = configGet('enableStrictSsl');
  if (strict && strict.value !== true)
    problems.push(
      `enableStrictSsl must be true, is ${JSON.stringify(strict.value)}: the audit's TLS must be verified`,
    );
  const network = configGet('networkSettings');
  if (
    network &&
    network.value !== undefined &&
    !(
      network.value &&
      typeof network.value === 'object' &&
      !Array.isArray(network.value) &&
      Object.keys(network.value).length === 0
    )
  )
    problems.push(
      `networkSettings must be empty, is ${JSON.stringify(network.value)}: no per-host proxy, CA or network override`,
    );
  // `plugins` is not readable with `config get`; the runtime list is: only yarn's built-ins and its core.
  const plugins = yarn(['plugin', 'runtime', '--json']);
  const pluginsFailed = spawnFailure(plugins, [0]);
  if (pluginsFailed) {
    problems.push(
      `yarn plugin runtime ${pluginsFailed}: ${String(plugins && (plugins.stderr || plugins.stdout)).slice(0, 300)}`,
    );
  } else {
    try {
      const extra = String(plugins.stdout)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .filter((pl) => !(pl && (pl.builtin === true || pl.name === '@@core')))
        .map((pl) => (pl && pl.name) || JSON.stringify(pl));
      if (extra.length)
        problems.push(
          `plugins must be [] (built-ins only), found ${extra.join(', ')}: a plugin can change what the audit asks or reports`,
        );
    } catch {
      problems.push(
        `yarn plugin runtime: unparseable output ${String(plugins.stdout).slice(0, 200)}`,
      );
    }
  }
  for (const key of AUDIT_IGNORE_SETTINGS) {
    const got = configGet(key);
    if (!got) continue;
    const value = got.value;
    if (!Array.isArray(value) || value.length) {
      problems.push(
        `${key} must be empty, is ${JSON.stringify(value)}: an ignore list hides advisories with no owner decision, scope or expiry (use tools/npm-audit-decisions.json)`,
      );
    }
  }
  return problems;
}

function publishedVersionsWith(yarn) {
  return (pkg) => {
    const r = yarn(['npm', 'info', pkg, '--fields', 'versions', '--json']);
    const failed = spawnFailure(r, [0]);
    if (failed)
      throw new Error(
        `yarn npm info ${pkg} ${failed}: ${String((r && (r.stderr || r.stdout)) || '').slice(0, 500)}`,
      );
    const versions = JSON.parse(r.stdout).versions;
    if (!Array.isArray(versions) || !versions.length)
      throw new Error(`yarn npm info ${pkg}: no versions`);
    return versions;
  };
}

function fetchAdvisoryWith(env) {
  return async (id) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ci-security-audit',
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/advisories/${id}`, {
      headers,
    });
    if (!res.ok) throw new Error(`GitHub advisory ${id}: HTTP ${res.status}`);
    return res.json();
  };
}

/** RUNTIME_PRUNE from runtime-deps.cjs, read in a child process (requiring it must not run its CLI here). */
function runtimePrune(root) {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m&&m.RUNTIME_PRUNE))',
      join(root, RUNTIME_DEPS_REL),
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

function productionWith(root, prune) {
  return (pkg) => {
    const { parse } = require('yaml');
    const rootManifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    const workspaces = new Map();
    for (const ws of rootManifest.workspaces.packages) {
      const m = JSON.parse(
        readFileSync(join(root, ws, 'package.json'), 'utf8'),
      );
      workspaces.set(m.name, m);
    }
    const shipped = SHIPPED.map(
      (dir) =>
        JSON.parse(
          readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
        ).name,
    );
    return productionPaths({
      lock: parse(readFileSync(join(root, 'yarn.lock'), 'utf8')),
      workspaces,
      shipped,
      resolutions: rootManifest.resolutions || {},
      prune,
      target: pkg,
    });
  };
}

/** Lookups run once per key; a failure is kept and fails every finding that needs it. */
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

/**
 * Returns the exit code (0 pass, 1 fail); throws on a fail-closed git error (the CLI turns that into exit 1).
 * Every outside dependency is injectable for the tests: `root`, `env`, `today` (YYYY-MM-DD), `yarn(args)` (a
 * spawnSync-shaped result), `fetchAdvisory(id)` (async), `production(pkg)` (chains) and `prune` (RUNTIME_PRUNE).
 */
async function main(argv = [], deps = {}) {
  const root = deps.root || ROOT;
  const env = deps.env || process.env;
  const today = deps.today || new Date().toISOString().slice(0, 10);
  const yarn = deps.yarn || defaultYarn(root);
  const fetchAdvisory = deps.fetchAdvisory || fetchAdvisoryWith(env);

  // A typo (e.g. --fail-on-expire) must not silently turn a control off: only these arguments exist.
  const unknown = argv.filter(
    (a, i) =>
      !(
        a === '--base' ||
        a === '--fail-on-expiring' ||
        argv[i - 1] === '--base'
      ),
  );
  if (unknown.length) {
    console.error(
      `::error::unknown argument(s) ${unknown.map((a) => JSON.stringify(a)).join(', ')}: the only arguments are --base <ref> and --fail-on-expiring`,
    );
    return 1;
  }
  const baseIdx = argv.indexOf('--base');
  let ref = null;
  if (baseIdx !== -1) {
    ref = argv[baseIdx + 1];
    if (!ref) throw new Error('--base needs a git ref');
    assertPlainRef(ref);
  } else if (String(env.GITHUB_EVENT_NAME || '').startsWith('pull_request')) {
    console.error(
      `::error::a pull_request run must pass --base <ref>: the decisions are read from the base ref, never from the PR's own ${REGISTER_REL}`,
    );
    return 1;
  }

  const registerFile = join(root, REGISTER_REL);
  const headRaw = existsSync(registerFile)
    ? readFileSync(registerFile, 'utf8')
    : null;
  const { register, source, errors } = selectRegister({
    ref,
    root,
    env,
    today,
    headRaw,
  });
  console.log(`decisions in force: ${REGISTER_REL} from ${source}`);
  const { valid } = register
    ? validateRegister(register, today)
    : { valid: new Map() };
  const failOnExpiring = argv.includes('--fail-on-expiring');
  for (const s of expiringSoon(valid, today)) {
    console.log(
      `::warning::npm-audit-decisions.json: ${s.id} expires ${s.expires} (${s.left} day(s) left): re-check for a fix, or the owner re-decides in a decision-only PR`,
    );
    // G3: the weekly run fails, so the expiry is noticed before every PR turns red.
    if (failOnExpiring)
      errors.push(
        `${s.id} expires ${s.expires}, ${s.left} day(s) left (--fail-on-expiring, the weekly run)`,
      );
  }

  const config = auditConfigProblems(yarn, env);
  if (config.length) {
    for (const p of config) console.error(`::error::${p}`);
    for (const e of errors)
      console.error(`::error::npm-audit-decisions.json ${e}`);
    return 1;
  }

  const r = yarn(AUDIT_ARGS);
  const failed = spawnFailure(r, [0, 1]);
  if (failed) {
    console.error(
      `::error::yarn npm audit ${failed}:\n${String((r && r.stdout) || '')}\n${String((r && r.stderr) || '')}`,
    );
    return 1;
  }
  let findings;
  try {
    findings = parseAudit(r.stdout);
  } catch (e) {
    console.error(`::error::${e.message}`);
    return 1;
  }
  if (r.status !== 0 && findings.length === 0) {
    console.error(
      `::error::yarn npm audit exited ${r.status} without a report:\n${r.stdout}\n${r.stderr}`,
    );
    return 1;
  }

  const needed = findings.filter((f) => f.id && valid.has(f.id));
  const advisories = new Map();
  for (const f of needed) {
    if (!advisories.has(f.id)) {
      advisories.set(
        f.id,
        await Promise.resolve()
          .then(() => fetchAdvisory(f.id))
          .then(
            (v) => ({ v }),
            (e) => ({ e }),
          ),
      );
    }
  }
  let production = deps.production;
  if (!production) {
    const prune = deps.prune
      ? { list: deps.prune, note: null }
      : runtimePrune(root);
    if (prune.note && needed.length) console.log(`note: ${prune.note}`);
    production = productionWith(root, prune.list);
  }
  const { undecided, decided, unused } = evaluate(findings, valid, {
    published: memo(publishedVersionsWith(yarn)),
    advisory: (id) => {
      const a = advisories.get(id);
      if (!a) throw new Error(`advisory ${id} was not looked up`);
      if (a.e) throw a.e;
      return a.v;
    },
    production: memo(production),
  });

  for (const f of decided) {
    console.log(
      `decided (accepted-risk up to ${f.decision.severity}, dev/build only, expires ${f.decision.expires}): ${f.id} ${f.pkg} ${f.treeVersions.join(', ')} [${f.severity}] ${f.issue}`,
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
  return undecided.length || errors.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::${e.stack || e.message}`);
      process.exit(1);
    },
  );
}

module.exports = {
  REGISTER_REL,
  inRange,
  fixShipped,
  productionPaths,
  isoDate,
  validateRegister,
  expiringSoon,
  parseAudit,
  evaluate,
  gitEnv,
  assertPlainRef,
  gitShowAt,
  mergeBaseOf,
  changedSince,
  changedSinceBase,
  readRegisterAt,
  registerChangedWith,
  isDecisionOnly,
  newOrChangedEntries,
  pullRequestUrl,
  selectRegister,
  spawnFailure,
  auditConfigProblems,
  main,
  MAX_DAYS,
  WARN_DAYS,
};
