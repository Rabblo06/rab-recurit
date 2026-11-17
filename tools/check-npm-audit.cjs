#!/usr/bin/env node
'use strict';
/**
 * ci-security "audit": `yarn npm audit --severity high --all --recursive`, with owner risk decisions.
 *
 * Every High/Critical advisory fails the job unless tools/npm-audit-decisions.json holds a VALID owner decision for that
 * exact advisory (GHSA id) and package. The register mirrors the image gate's (packages/rab-docker/docs/
 * IMAGE_SECURITY_RELEASE_POLICY.md section 5) and is NOT an ignore list:
 *   - an entry names exactly one GHSA id and an explicit list of exact package names (no wildcard);
 *   - it carries the owner's written decision (owner_decision_ref, decided_by, decided_on) and a justification;
 *   - it expires at most 180 days after decided_on; an expired, incomplete or over-long entry fails the job;
 *   - it never covers a FIXABLE finding: if the registry has a newer release in the SAME major as an installed
 *     (tree) version that is outside the advisory's vulnerable range, the finding fails whatever the register says,
 *     so a decision lapses the moment an in-major fix ships. Fix it by upgrading;
 *   - an unused entry is reported (warning) so it can be removed.
 * Fails closed: an audit that exits non-zero without a parseable report, a registry lookup that fails, or a vulnerable
 * range this file cannot evaluate all fail the job. There is no date override.
 *
 *   node tools/check-npm-audit.cjs        # exit 1 on any undecided High/Critical advisory or invalid decision
 *   node --test tools/check-npm-audit.test.cjs
 */
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const REGISTER = join(__dirname, 'npm-audit-decisions.json');
const AUDIT_ARGS = [
  'npm',
  'audit',
  '--severity',
  'high',
  '--all',
  '--recursive',
  '--json',
];
const DECISIONS = ['accepted-risk', 'not-affected', 'false-positive'];
const MAX_DAYS = 180;
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
/** True/false for `<=4.0.7`, `>=2.0.0 <2.3.2 || >=4.0.0 <4.0.4`, ...; throws on a range it cannot evaluate. */
function inRange(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`cannot evaluate version ${version}`);
  return String(range)
    .split('||')
    .some((alt) => {
      const parts = alt.trim().split(/\s+/).filter(Boolean);
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
/** Tree versions for which the registry has a newer same-major release outside the vulnerable range. */
function fixableTreeVersions(treeVersions, vulnerableRange, publishedVersions) {
  return treeVersions.filter((tv) => {
    const t = parseVersion(tv);
    if (!t) throw new Error(`cannot evaluate tree version ${tv}`);
    return publishedVersions.some((pv) => {
      const p = parseVersion(pv);
      return (
        p && p[0] === t[0] && cmp(p, t) > 0 && !inRange(pv, vulnerableRange)
      );
    });
  });
}

// --- register ---
const isoDate = (s) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    ? Date.parse(`${s}T00:00:00Z`)
    : null;

/** Returns { valid: Map<id, decision>, errors: string[] }. `today` is a YYYY-MM-DD string (UTC). */
function validateRegister(register, today) {
  const errors = [];
  const valid = new Map();
  if (
    !register ||
    register.schema !== 1 ||
    !Array.isArray(register.decisions)
  ) {
    return {
      valid,
      errors: [
        'npm-audit-decisions.json: expected { "schema": 1, "decisions": [...] }',
      ],
    };
  }
  const now = isoDate(today);
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
    if (valid.has(d.id)) bad('duplicate id');
    if (
      !Array.isArray(d.packages) ||
      !d.packages.length ||
      d.packages.some((p) => typeof p !== 'string' || !p || /[*?]/.test(p))
    ) {
      bad('packages must be a non-empty list of exact package names');
    }
    if (!DECISIONS.includes(d.decision))
      bad(`decision must be one of ${DECISIONS.join(', ')}`);
    if (
      typeof d.owner_decision_ref !== 'string' ||
      !REF.test(d.owner_decision_ref)
    )
      bad(
        'owner_decision_ref must link the owner decision (issue or PR in this repository)',
      );
    if (typeof d.decided_by !== 'string' || !d.decided_by.trim())
      bad('decided_by is required');
    if (
      typeof d.justification !== 'string' ||
      d.justification.trim().length < 40
    )
      bad('justification (reachability evidence) is required');
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
 * Verdict per finding. `published(pkg)` returns the registry's version list (only called for findings with a decision).
 * Returns { undecided, decided, unused }.
 */
function evaluate(findings, valid, published) {
  const undecided = [];
  const decided = [];
  const used = new Set();
  for (const f of findings) {
    const d = f.id ? valid.get(f.id) : undefined;
    if (!d || !d.packages.includes(f.pkg)) {
      undecided.push({ ...f, reason: 'no owner decision' });
      continue;
    }
    used.add(d.id);
    let fixable;
    try {
      fixable = fixableTreeVersions(f.treeVersions, f.range, published(f.pkg));
    } catch (e) {
      undecided.push({
        ...f,
        reason: `decision cannot be applied: ${e.message}`,
      });
      continue;
    }
    if (fixable.length) {
      undecided.push({
        ...f,
        reason: `FIXABLE in the same major for ${fixable.join(', ')}: a decision never covers a fixable finding, upgrade`,
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

function main() {
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

  const cache = new Map();
  const published = (pkg) => {
    if (!cache.has(pkg)) cache.set(pkg, publishedVersions(pkg));
    return cache.get(pkg);
  };
  const { undecided, decided, unused } = evaluate(findings, valid, published);

  for (const f of decided) {
    console.log(
      `decided (${f.decision.decision}, expires ${f.decision.expires}): ${f.id} ${f.pkg} ${f.treeVersions.join(', ')} [${f.severity}] ${f.issue}`,
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

if (require.main === module) main();

module.exports = {
  inRange,
  fixableTreeVersions,
  validateRegister,
  parseAudit,
  evaluate,
  MAX_DAYS,
};
