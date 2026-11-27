// M9 hardening (Lane F) — loopback stand-ins for the two external services a production-mode API and Worker need during
// a load test on a DISPOSABLE stack: an S3-compatible object store (path-style; PUT / GET / HEAD / DELETE objects,
// ListObjectsV2, HEAD bucket; no signature check, loopback only) and an SMTP sink that accepts and discards every message.
// Neither is part of the product; they exist so the Worker's statement, report and e-mail jobs run their real code path
// (render, upload, send) instead of failing and retrying, which would distort the measurement.
//
//   node packages/rab-e2e-testing/system/perf/sinks.mjs <data dir> [s3 port=19000] [smtp port=2525]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, relative } from 'node:path';

const [dataDir, s3Port = '19000', smtpPort = '2525'] = process.argv.slice(2);
if (!dataDir) throw new Error('usage: sinks.mjs <data dir> [s3 port] [smtp port]');
const stats = { put: 0, get: 0, head: 0, del: 0, list: 0, mails: 0 };

/** aws-chunked (SDK v3 streaming uploads): `<hex size>[;chunk-signature=..]\r\n<data>\r\n ... 0\r\n<trailers>\r\n\r\n`. */
function decodeAwsChunked(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = parseInt(buf.subarray(i, eol).toString('latin1').split(';')[0], 16);
    if (!size) break;
    out.push(buf.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/');
    const key = rest.join('/');
    const file = join(dataDir, 's3', bucket ?? '', key);
    if (!file.startsWith(join(dataDir, 's3'))) return res.writeHead(400).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!key && req.method === 'HEAD') return res.writeHead(200).end();
      if (!key && req.method === 'GET') {
        stats.list++;
        const prefix = u.searchParams.get('prefix') ?? '';
        const base = join(dataDir, 's3', bucket);
        const items = walk(base).map((f) => ({ k: relative(base, f).split('\\').join('/'), s: statSync(f) })).filter((x) => x.k.startsWith(prefix)).slice(0, 1000);
        const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${items.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items
          .map((x) => `<Contents><Key>${xml(x.k)}</Key><LastModified>${x.s.mtime.toISOString()}</LastModified><Size>${x.s.size}</Size><ETag>"x"</ETag><StorageClass>STANDARD</StorageClass></Contents>`)
          .join('')}</ListBucketResult>`;
        return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
      }
      if (req.method === 'PUT') {
        stats.put++;
        let body = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
        return res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        stats[req.method === 'GET' ? 'get' : 'head']++;
        if (!existsSync(file)) return res.writeHead(404, { 'Content-Type': 'application/xml' }).end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined);
        const body = readFileSync(file);
        res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream', ETag: `"${createHash('md5').update(body).digest('hex')}"`, 'Last-Modified': statSync(file).mtime.toUTCString() });
        return res.end(req.method === 'GET' ? body : undefined);
      }
      if (req.method === 'DELETE') {
        stats.del++;
        rmSync(file, { force: true });
        return res.writeHead(204).end();
      }
      if (req.method === 'POST' && u.searchParams.has('delete')) {
        stats.del++;
        const keys = [...Buffer.concat(chunks).toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
        for (const k of keys) rmSync(join(dataDir, 's3', bucket, k), { force: true });
        return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<DeleteResult>${keys.map((k) => `<Deleted><Key>${xml(k)}</Key></Deleted>`).join('')}</DeleteResult>`);
      }
      return res.writeHead(501).end();
    });
  })
  .listen(Number(s3Port), '127.0.0.1');

// SMTP: just enough of RFC 5321 for nodemailer (EHLO without STARTTLS/AUTH, MAIL, RCPT, DATA, RSET, NOOP, QUIT).
net
  .createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 lanef-sink ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          buf = buf.slice(end + 5);
          inData = false;
          stats.mails++;
          sock.write('250 OK queued\r\n');
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol < 0) return;
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write('250-lanef-sink\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
        else if (cmd === 'HELO') sock.write('250 lanef-sink\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          sock.end('221 Bye\r\n');
          return;
        } else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  })
  .listen(Number(smtpPort), '127.0.0.1');

setInterval(() => writeFileSync(join(dataDir, 'sinks-stats.json'), JSON.stringify(stats)), 10_000);
console.log(`[sinks] s3 127.0.0.1:${s3Port}, smtp 127.0.0.1:${smtpPort}, data ${dataDir}`);
