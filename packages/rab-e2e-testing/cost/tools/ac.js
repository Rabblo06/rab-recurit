// Runs INSIDE a node:24-alpine container on crewflow-cost-net (so the load generator does not share the API's CPU
// quota and talks to the API over the container network). argv[2] = JSON config. Prints one `RESULT {json}` line.
// Unchanged in substance from the 2026-10-26 harness: autocannon 8.0.0, distinct cf-connecting-ip per request.
const autocannon = require('autocannon');
const cfg = JSON.parse(process.argv[2]);
let n = 0;
const rip = () => { n++; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${(n & 255) || 1}`; };
const lat = [];
const inst = autocannon({
  url: cfg.base, connections: cfg.c, duration: cfg.d, timeout: 30,
  requests: [{
    method: cfg.method || 'GET', path: cfg.paths ? cfg.paths[0] : cfg.path, headers: cfg.headers, body: cfg.body,
    setupRequest: (req) => {
      req.headers = { ...cfg.headers, 'cf-connecting-ip': rip() };
      if (cfg.paths) req.path = cfg.paths[n % cfg.paths.length];
      return req;
    },
  }],
});
inst.on('response', (_c, _s, _b, t) => lat.push(t));
inst.on('done', (r) => {
  lat.sort((a, b) => a - b);
  const p = (q) => +lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(2);
  console.log('RESULT ' + JSON.stringify({
    requests: r.requests.total, durationS: r.duration, rps: r.requests.average, throughputBytesPerSec: r.throughput.average,
    latency: { p50: r.latency.p50, p90: r.latency.p90, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, mean: r.latency.mean },
    latencyExact: lat.length ? { p50: p(0.5), p95: p(0.95), p99: p(0.99), n: lat.length } : null,
    non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, statusCodeStats: r.statusCodeStats,
  }));
});
