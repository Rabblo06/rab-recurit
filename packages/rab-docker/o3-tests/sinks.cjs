'use strict';
/**
 * O3 real-container tests (Agent 5): ONE test-only sink container for the disposable `o3t-*` stacks, so the stack stays at
 * five containers (PostgreSQL, Redis, API, Worker, sinks).
 *
 *   - SMTP sink on :2525: accepts every message (AUTH accepted without checking, never relays) and writes /out/mail/<n>.eml.
 *   - Minimal S3-compatible object store on :9000 (path-style): PutObject (plain and aws-chunked bodies), GetObject,
 *     HeadObject, DeleteObject, ListObjectsV2, HeadBucket. Objects live in memory and are mirrored to /out/s3/ (key with
 *     '/' replaced) so the driver can read them back with `docker exec`. Signatures are NOT verified: this is a sink, never
 *     a store anything else relies on. It makes no outbound connection at all.
 *
 * Test-only. Never part of a deployment.
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const OUT = process.env.SINK_OUT || '/out';
fs.mkdirSync(`${OUT}/mail`, { recursive: true });
fs.mkdirSync(`${OUT}/s3`, { recursive: true });

// ----------------------------------------------------------------------------------------------------------------- SMTP
let mailCount = 0;
net
  .createServer((socket) => {
    let buffer = '';
    let inData = false;
    let authStep = 0;
    let message = [];
    let envelope = { from: '', to: [] };
    socket.write('220 o3t-sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mailCount += 1;
            const file = `${OUT}/mail/${Date.now()}-${mailCount}.eml`;
            fs.writeFileSync(file, `X-Sink-Mail-From: ${envelope.from}\nX-Sink-Rcpt-To: ${envelope.to.join(',')}\n${message.join('\n')}\n`);
            console.log(`o3t-sink smtp: stored message ${mailCount}`);
            message = [];
            envelope = { from: '', to: [] };
            socket.write('250 OK stored\r\n');
          } else {
            message.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (authStep > 0) {
          // AUTH LOGIN continuation lines (base64 user, then password): accepted, never stored or logged.
          authStep -= 1;
          socket.write(authStep > 0 ? '334 UGFzc3dvcmQ6\r\n' : '235 Authentication successful\r\n');
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-o3t-sink\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n');
        else if (verb === 'HELO') socket.write('250 o3t-sink\r\n');
        else if (verb === 'AUTH') {
          const parts = line.split(' ');
          if ((parts[1] || '').toUpperCase() === 'LOGIN') {
            authStep = parts[2] ? 1 : 2;
            socket.write(parts[2] ? '334 UGFzc3dvcmQ6\r\n' : '334 VXNlcm5hbWU6\r\n');
          } else socket.write('235 Authentication successful\r\n');
        } else if (verb === 'MAIL') {
          envelope.from = line.slice(10).trim();
          socket.write('250 OK\r\n');
        } else if (verb === 'RCPT') {
          envelope.to.push(line.slice(8).trim());
          socket.write('250 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 OK\r\n');
        else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  })
  .listen(2525, () => console.log('o3t-sink smtp: listening on 2525'));

// ------------------------------------------------------------------------------------------------------------------- S3
const objects = new Map(); // `${bucket}/${key}` -> { body, type, etag, modified }

/** Decodes an aws-chunked body ("<hex>[;ext]\r\n<data>\r\n ... 0[;ext]\r\n<trailers>\r\n\r\n"). */
function decodeAwsChunked(raw) {
  const parts = [];
  let pos = 0;
  for (;;) {
    const eol = raw.indexOf('\r\n', pos);
    if (eol < 0) break;
    const size = parseInt(raw.slice(pos, eol).toString('latin1').split(';')[0], 16);
    pos = eol + 2;
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.slice(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(parts);
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const notFound = (res, code = 'NoSuchKey') => {
  res.writeHead(404, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>not found</Message></Error>`);
};

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://sink');
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const slash = path.indexOf('/');
      const bucket = slash < 0 ? path : path.slice(0, slash);
      const key = slash < 0 ? '' : path.slice(slash + 1);
      const id = `${bucket}/${key}`;
      if (!bucket) return notFound(res, 'NoSuchBucket');
      if (!key) {
        if (req.method === 'HEAD') {
          res.writeHead(200);
          return res.end();
        }
        if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
          const prefix = url.searchParams.get('prefix') || '';
          const keys = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)).sort();
          const contents = keys
            .map((k) => {
              const o = objects.get(`${bucket}/${k}`);
              return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.modified}</LastModified><ETag>"${o.etag}"</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
            })
            .join('');
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          return res.end(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          );
        }
        return notFound(res, 'NoSuchBucket');
      }
      if (req.method === 'PUT') {
        let body = Buffer.concat(chunks);
        const encoding = String(req.headers['content-encoding'] || '');
        if (encoding.includes('aws-chunked') || req.headers['x-amz-decoded-content-length'] !== undefined) body = decodeAwsChunked(body);
        const etag = crypto.createHash('md5').update(body).digest('hex');
        objects.set(id, { body, type: String(req.headers['content-type'] || 'application/octet-stream'), etag, modified: new Date().toISOString() });
        fs.writeFileSync(`${OUT}/s3/${key.replace(/[^A-Za-z0-9._-]/g, '_')}`, body);
        console.log(`o3t-sink s3: stored ${body.length} bytes`);
        res.writeHead(200, { ETag: `"${etag}"` });
        return res.end();
      }
      const o = objects.get(id);
      if (req.method === 'DELETE') {
        objects.delete(id);
        res.writeHead(204);
        return res.end();
      }
      if (!o) return notFound(res);
      const headers = { 'Content-Type': o.type, 'Content-Length': o.body.length, ETag: `"${o.etag}"`, 'Last-Modified': new Date(o.modified).toUTCString() };
      if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, headers);
        return res.end(o.body);
      }
      res.writeHead(405);
      res.end();
    });
  })
  .listen(9000, () => console.log('o3t-sink s3: listening on 9000'));
