'use strict';
/**
 * O3 real-container tests (Agent 5): shared helpers for run-o3-tests.cjs. Test-only.
 *
 * Every secret is generated per run, written only under the run's own secrets directory (outside the repository) and
 * passed to the docker CLI through its ENVIRONMENT (`-e NAME` without a value), never on a command line. Every captured
 * output is redacted before it is written to an evidence file.
 */
const { spawnSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RD = path.resolve(__dirname, '..'); // packages/rab-docker
const FILES = ['-f', 'docker-compose.image.yml', '-f', 'docker-compose.local-db.yml', '-f', 'o3-tests/docker-compose.o3t.yml'];

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, Math.ceil((n * 4) / 3) - 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Ctx {
  constructor(major, out) {
    this.major = major;
    this.project = `o3t-pg${major}`;
    this.out = out;
    this.secretsDir = path.join(out, 'secrets');
    this.secrets = {};
    this.log = [];
  }

  redact(text) {
    let s = String(text ?? '');
    for (const v of Object.values(this.secrets)) if (v && v.length >= 8) s = s.split(v).join('<redacted>');
    return s.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://<redacted>').replace(/redis:\/\/[^\s'"]+/g, 'redis://<redacted>');
  }

  note(line) {
    const l = this.redact(line);
    this.log.push(l);
    console.log(`[o3t-pg${this.major}] ${l}`);
  }

  evidence(name, text) {
    fs.mkdirSync(path.join(this.out, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(this.out, 'evidence', name), this.redact(text));
  }

  /** Runs a command; env values reach the CLI only through the environment. */
  run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd ?? RD,
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: 'utf8',
      timeout: opts.timeout ?? 600_000,
      maxBuffer: 64 * 1024 * 1024,
      input: opts.input,
    });
    return { code: r.status ?? (r.error ? -1 : 0), out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', error: r.error };
  }

  composeEnvFile() {
    return path.join(this.secretsDir, 'compose.env');
  }

  compose(args, opts = {}) {
    return this.run('docker', ['compose', '-p', this.project, '--env-file', this.composeEnvFile(), ...(opts.extraEnvFile ? ['--env-file', opts.extraEnvFile] : []), ...FILES, ...args], opts);
  }

  container(service) {
    return `${this.project}-${service}-1`;
  }

  psql(sql, db = 'crewflow') {
    const r = this.run('docker', ['exec', '-i', this.container('rab-postgres'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], { input: sql, timeout: 120_000 });
    if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${this.redact(r.out).slice(0, 600)}`);
    return r.stdout.trim();
  }

  psqlCode(sql, db = 'crewflow') {
    return this.run('docker', ['exec', '-i', this.container('rab-postgres'), 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], { input: sql, timeout: 120_000 });
  }

  redis(args) {
    return this.run('docker', ['exec', '-e', 'REDISCLI_AUTH', this.container('rab-redis'), 'redis-cli', '--no-auth-warning', '--user', 'crewflow', ...args], {
      env: { REDISCLI_AUTH: this.secrets.redis },
      timeout: 60_000,
    });
  }

  /** Every BullMQ job scheduler: SCAN for the `<prefix>:<queue>:repeat` sorted sets, then their members. */
  schedulers() {
    const keys = new Set();
    let cursor = '0';
    do {
      const r = this.redis(['SCAN', cursor, 'MATCH', '*:repeat', 'COUNT', '1000']);
      if (r.code !== 0) throw new Error(`redis SCAN failed: ${this.redact(r.out)}`);
      const lines = r.stdout.trim().split('\n');
      cursor = lines[0].trim();
      for (const k of lines.slice(1)) if (k.trim()) keys.add(k.trim());
    } while (cursor !== '0');
    const out = [];
    for (const key of [...keys].sort()) {
      const t = this.redis(['TYPE', key]).stdout.trim();
      if (t !== 'zset') continue;
      const members = this.redis(['ZRANGE', key, '0', '-1']).stdout.trim().split('\n').filter(Boolean);
      for (const m of members) out.push(`${key}|${m.trim()}`);
    }
    return out.sort();
  }

  logs(service, since) {
    return this.run('docker', ['logs', ...(since ? ['--since', since] : []), this.container(service)], { timeout: 60_000 }).out;
  }

  healthStatus(service) {
    return this.run('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{.State.Status}}|{{.State.ExitCode}}', this.container(service)]).stdout.trim();
  }

  async waitFor(label, fn, timeoutMs, everyMs = 3000) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch (e) {
        v = false;
      }
      if (v) return Date.now() - t0;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label} (${Math.round(timeoutMs / 1000)} s)`);
      await sleep(everyMs);
    }
  }

  async waitHealthy(service, timeoutMs) {
    return this.waitFor(`${service} healthy`, () => {
      const s = this.healthStatus(service);
      if (/\|exited\|/.test(s)) throw new Error(`${service} exited: ${s}`);
      return s.startsWith('healthy|');
    }, timeoutMs, 3000);
  }

  healthz() {
    const r = this.run('docker', ['exec', this.container('rab-api'), 'wget', '-qO-', 'http://localhost:3000/healthz'], { timeout: 30_000 });
    return { code: r.code, body: r.stdout.trim() };
  }

  ledger() {
    return this.psql('SELECT name FROM core.migrations ORDER BY timestamp, id').split('\n').filter(Boolean);
  }
}

module.exports = { Ctx, RD, FILES, hex, b64, sleep };
