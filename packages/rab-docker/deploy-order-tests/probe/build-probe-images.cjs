'use strict';
/**
 * Deploy-order real-container tests (TEST-ONLY, never a release): builds the two probe images, each = the image under test
 * plus ONE probe migration of this folder, so a failed UPGRADE migration can be exercised on a seeded database (C3). No
 * real migration file is edited and nothing else changes. Built locally and pushed only to the operator's 127.0.0.1
 * registry, never to Docker Hub.
 *
 *   node packages/rab-docker/deploy-order-tests/probe/build-probe-images.cjs <base image ref pinned @sha256> <tag prefix>
 *     -> <tag prefix>-DotProbeFail, <tag prefix>-DotProbePartial
 *
 * The build file is generated here (stdin) with the base PINNED BY DIGEST, so no unpinned `FROM ${ARG}` Dockerfile is tracked
 * in the repository (the image gate's static check covers every tracked Dockerfile under packages/rab-docker).
 */
const { spawnSync } = require('node:child_process');

const [base, prefix] = process.argv.slice(2);
if (!/^[a-z0-9./_:-]+@sha256:[0-9a-f]{64}$/.test(base ?? '') || !/^[a-z0-9._/:-]+$/.test(prefix ?? '')) {
  console.error('usage: build-probe-images.cjs <repository@sha256:<64 hex>> <tag prefix>');
  process.exit(2);
}
const MIGRATIONS = '/app/packages/rab-server/dist/database/typeorm/core/migrations';
for (const probe of ['1786799990001-DotProbeFail', '1786799990002-DotProbePartial']) {
  const dockerfile = `FROM ${base}\nCOPY --chown=root:root --chmod=644 ${probe}.js ${MIGRATIONS}/${probe}.js\n`;
  const tag = `${prefix}-${probe.slice(14)}`;
  const r = spawnSync('docker', ['build', '-q', '-t', tag, '-f', '-', __dirname], { input: dockerfile, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  if (r.status !== 0) {
    console.error(`build of ${tag} failed`);
    process.exit(1);
  }
  console.log(`${tag} ${r.stdout.trim()}`);
}
