'use strict';
/**
 * Native-addon smoke check, run by the image gate (`image_gate.py container`) INSIDE the finished image as the runtime
 * user (1000:1000, --network none, read-only root): bind-mounted, never copied into an image. Dependency-free.
 *
 *   node native-addons-smoke.cjs [<app root>=/app]
 *
 * The runtime image has no compiler and, since the node-gyp prune, no node-gyp: the two native addons the processes load
 * must work from what is shipped. Fails (exit 1) unless
 *   - argon2, resolved exactly as the compiled API resolves it (from packages/rab-server/dist), hashes with argon2id at
 *     the platform minimum (m=19456, t=2, p=1), the hash encodes those parameters, it verifies, and a wrong password
 *     does not;
 *   - msgpackr, resolved exactly as BullMQ (the queue client of the API and the Worker) resolves it, reports native
 *     acceleration enabled (`isNativeAccelerationEnabled`, set only when msgpackr-extract's native extractor loaded),
 *     and msgpackr-extract, required from msgpackr's own location, exposes the native `extractStrings` function;
 *     a packed message with long strings round-trips.
 * Any exception is a failure (fail closed). Prints `native-addons-smoke: OK ...` on success.
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const app = path.resolve(process.argv[2] || '/app');

async function main() {
  // argon2 as the API loads it.
  const apiRequire = createRequire(path.join(app, 'packages', 'rab-server', 'dist', 'main.js'));
  const argon2Path = apiRequire.resolve('argon2');
  const argon2 = apiRequire('argon2');
  const opts = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
  const hash = await argon2.hash('native-addons-smoke correct horse', opts);
  if (!hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')) throw new Error(`argon2 hash does not encode argon2id m=19456,t=2,p=1: ${hash.slice(0, 40)}`);
  if ((await argon2.verify(hash, 'native-addons-smoke correct horse')) !== true) throw new Error('argon2 verify rejected the right password');
  if ((await argon2.verify(hash, 'native-addons-smoke wrong horse')) !== false) throw new Error('argon2 verify accepted a wrong password');

  // msgpackr as BullMQ loads it (from the Worker's resolution; the API resolves the same hoisted copy).
  const workerRequire = createRequire(path.join(app, 'packages', 'rab-worker', 'dist', 'main.js'));
  const bullmqRequire = createRequire(workerRequire.resolve('bullmq'));
  const msgpackrPath = bullmqRequire.resolve('msgpackr');
  const msgpackr = bullmqRequire('msgpackr');
  if (msgpackr.isNativeAccelerationEnabled !== true) throw new Error(`msgpackr native acceleration is not enabled (${msgpackrPath}): msgpackr-extract did not load`);
  const extract = createRequire(msgpackrPath)('msgpackr-extract');
  if (typeof extract.extractStrings !== 'function') throw new Error('msgpackr-extract loaded without its native extractStrings');
  const packr = new msgpackr.Packr();
  const value = { a: 'x'.repeat(200), b: 'ü'.repeat(64), n: [1, 2, 3] };
  if (JSON.stringify(packr.unpack(packr.pack(value))) !== JSON.stringify(value)) throw new Error('msgpackr round-trip changed the value');

  console.log(
    `native-addons-smoke: OK argon2id m=19456,t=2,p=1 hash+verify (${path.relative(app, argon2Path)}); ` +
      `msgpackr native acceleration enabled (${path.relative(app, msgpackrPath)}), extractStrings native; uid ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}`,
  );
}

main().catch((e) => {
  console.error(`native-addons-smoke: FAIL: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  process.exit(1);
});
