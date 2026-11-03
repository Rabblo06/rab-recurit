#!/usr/bin/env node
'use strict';
/**
 * Builds packages/rab-docker/rab/seccomp/chromium-worker.json — the Worker container's seccomp profile — from Docker's own
 * default profile (moby/profiles, pinned below by commit AND sha256) plus exactly three rules, the minimum Chromium's
 * namespace sandbox needs (proved in Docker hardening H6, owner decision 2026-11-03 "require the Chromium OS sandbox"):
 *
 *   1. clone   with CLONE_NEWUSER / NEWPID / NEWNET / NEWIPC allowed for processes WITHOUT CAP_SYS_ADMIN;
 *              CLONE_NEWNS, CLONE_NEWCGROUP and CLONE_NEWUTS stay refused (masked-equal-zero on those bits);
 *   2. unshare with the same rule;
 *   3. chroot  for processes WITHOUT CAP_SYS_CHROOT: the syscall becomes reachable, but the kernel still requires
 *              CAP_SYS_CHROOT in the caller's OWN user namespace, i.e. only inside a namespace the process created
 *              (Chromium chroots its sandboxed children into /proc/self/fdinfo).
 * clone3 keeps Docker's ENOSYS (libc falls back to clone, which these rules govern). Nothing else differs.
 *
 *   node build-chromium-worker-profile.cjs           write chromium-worker.json
 *   node build-chromium-worker-profile.cjs --check   exit 1 unless the committed file equals the generated one
 *
 * Updating the base: download seccomp/default.json at a newer moby/profiles commit next to this file, change UPSTREAM
 * (commit + sha256), regenerate, review the diff, and re-run the Chromium sandbox evidence (chrome://sandbox, renderer
 * namespaces) and the PDF render gate on amd64 and arm64.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPSTREAM = Object.freeze({
  commit: '6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef', // moby/profiles, seccomp/default.json, 2026-09-17
  sha256: '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6',
});
const OUT = path.join(__dirname, 'chromium-worker.json');

const CLONE_NEWNS = 0x00020000;
const CLONE_NEWCGROUP = 0x02000000;
const CLONE_NEWUTS = 0x04000000;
const STILL_REFUSED = CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS;

const H6_RULES = Object.freeze([
  {
    names: ['clone'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: STILL_REFUSED, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }],
    excludes: { caps: ['CAP_SYS_ADMIN'], arches: ['s390', 's390x'] },
    comment: 'Crewflow H6: Chromium namespace sandbox. CLONE_NEWUSER/NEWPID/NEWNET/NEWIPC allowed; CLONE_NEWNS/NEWCGROUP/NEWUTS still refused.',
  },
  {
    names: ['unshare'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: STILL_REFUSED, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }],
    excludes: { caps: ['CAP_SYS_ADMIN'] },
    comment: 'Crewflow H6: same namespace set as clone.',
  },
  {
    names: ['chroot'],
    action: 'SCMP_ACT_ALLOW',
    excludes: { caps: ['CAP_SYS_CHROOT'] },
    comment: 'Crewflow H6: reachable syscall; the kernel still requires CAP_SYS_CHROOT in the caller user namespace (only inside a namespace the process created).',
  },
]);

function upstream() {
  const file = path.join(__dirname, `moby-default-${UPSTREAM.commit}.json`);
  const raw = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha !== UPSTREAM.sha256) throw new Error(`${path.basename(file)}: sha256 ${sha} != pinned ${UPSTREAM.sha256}`);
  return JSON.parse(raw.toString('utf8'));
}

function build() {
  const profile = upstream();
  profile.syscalls = [...profile.syscalls, ...H6_RULES];
  return `${JSON.stringify(profile, null, 1)}\n`;
}

module.exports = { UPSTREAM, H6_RULES, STILL_REFUSED, build, OUT };

if (require.main === module) {
  const text = build();
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (committed !== text) {
      console.error(`${path.relative(process.cwd(), OUT)} is not the generated profile (run this script without --check)`);
      process.exit(1);
    }
    console.log('chromium-worker.json matches the pinned Docker default + the 3 H6 rules');
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  }
}
