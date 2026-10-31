// Counts the S3 calls recorded by scripts/storage-trace.sh (MinIO `mc admin trace --json`): by S3 API, by client
// container, and per stored_file row. MEASURED — every call MinIO served in the window, nothing modelled.
//   node lib/storage-ops.js <label> [storedFileRows]
const fs = require('fs');
const path = require('path');
const { OUT, psql, writeJson } = require('./lib');

const label = process.argv[2];
const file = path.join(OUT, `storage-${label}.trace.jsonl`);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('{'));
const ipToName = {};
const clientsFile = path.join(OUT, `storage-${label}.clients.txt`);
if (fs.existsSync(clientsFile)) for (const l of fs.readFileSync(clientsFile, 'utf8').split(/\r?\n/).filter(Boolean)) { const [n, ip] = l.split(' '); if (ip) ipToName[ip.split('/')[0]] = n; }
const tracerIp = Object.entries(ipToName).find(([, n]) => n === 'costaudit-trace')?.[0];

// Cloudflare R2 operation classes (QUOTED from R2 pricing docs): Class A = mutating/list, Class B = read/head.
const CLASS = { 's3.PutObject': 'A', 's3.ListObjectsV2': 'A', 's3.ListObjects': 'A', 's3.CopyObject': 'A', 's3.CreateMultipartUpload': 'A', 's3.PutObjectPart': 'A', 's3.CompleteMultipartUpload': 'A', 's3.DeleteObject': 'free', 's3.DeleteMultipleObjects': 'free', 's3.GetObject': 'B', 's3.HeadObject': 'B', 's3.HeadBucket': 'B' };
const SHORT = { 's3.HeadObject': 'HEAD', 's3.ListObjectsV2': 'LIST', 's3.ListObjects': 'LIST', 's3.GetObject': 'GET', 's3.PutObject': 'PUT', 's3.DeleteObject': 'DELETE', 's3.DeleteMultipleObjects': 'DELETE' };

const byApi = {}, byClient = {}, byStatus = {};
let total = 0;
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type !== 'S3') continue;
  const ip = String(e.client || '').replace(/:\d+$/, '');
  if (ip === tracerIp) continue;
  total++;
  const api = e.api;
  byApi[api] = (byApi[api] || 0) + 1;
  const who = ipToName[ip] || `other(${ip})`;
  (byClient[who] ||= {})[SHORT[api] || api] = ((byClient[who] || {})[SHORT[api] || api] || 0) + 1;
  byStatus[`${SHORT[api] || api} ${e.statusCode}`] = (byStatus[`${SHORT[api] || api} ${e.statusCode}`] || 0) + 1;
}
const ops = { HEAD: 0, LIST: 0, GET: 0, PUT: 0, DELETE: 0, OTHER: 0 };
for (const [api, n] of Object.entries(byApi)) ops[SHORT[api] || 'OTHER'] += n;
const classA = Object.entries(byApi).reduce((s, [a, n]) => s + (CLASS[a] === 'A' ? n : 0), 0);
const classB = Object.entries(byApi).reduce((s, [a, n]) => s + (CLASS[a] === 'B' ? n : 0), 0);
const rows = process.argv[3] ? Number(process.argv[3]) : Number(psql('select count(*) from core.stored_file'));
const rowsByStatus = psql(`select status||'='||count(*) from core.stored_file group by status order by status`).split('\n').filter(Boolean);
const objects = Number(psql(`select count(*) from core.stored_file where status='AVAILABLE'`));
const per = (n) => (rows ? +(n / rows).toFixed(4) : null);
const out = {
  label, label_kind: 'MEASURED', method: 'MinIO mc admin trace --json; every S3 call served during the window, tracer excluded',
  window: { start: fs.readFileSync(path.join(OUT, `storage-${label}.t-start`), 'utf8').trim(), end: fs.readFileSync(path.join(OUT, `storage-${label}.t-end`), 'utf8').trim() },
  totalS3Calls: total, ops, byApi, byClient, byStatus,
  storedFileRows: rows, storedFileRowsByStatus: rowsByStatus, availableObjects: objects,
  perStoredFileRow: { HEAD: per(ops.HEAD), LIST: per(ops.LIST), GET: per(ops.GET), PUT: per(ops.PUT), total: per(total) },
  r2Classes_DERIVED: { classA, classB, note: 'R2 Class A = PUT/LIST/COPY/multipart, Class B = GET/HEAD (mapping QUOTED from Cloudflare R2 pricing)' },
};
writeJson(`storage-${label}.json`, out);
console.log(JSON.stringify({ label, totalS3Calls: total, ops, perStoredFileRow: out.perStoredFileRow, storedFileRows: rows, byClient }, null, 1));
