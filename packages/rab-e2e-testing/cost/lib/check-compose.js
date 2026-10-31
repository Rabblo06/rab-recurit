// Static isolation check of the rendered crewflow-cost compose model (`docker compose config --format json` on stdin).
// The model contains interpolated secrets, so this prints ONLY service names, mount targets/sources, ports and network
// / volume names - never an environment value. Exit 0 = isolated, 1 = a finding (each printed as `ISOLATION: ...`).
//
// Rules (lib/guard.sh, README "Safety"):
//   - project name is crewflow-cost; every container_name starts with costaudit-
//   - bind mounts: read-only, source inside the harness folder, never inside the main checkout, never the Docker socket
//   - named volumes: declared by this project, not external, named crewflow-cost_*
//   - networks: only crewflow-cost-net, not external; no network_mode host/container:, no pid/ipc host, no privileged
//   - ports: host_ip 127.0.0.1, never a dev/test/e2e port
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const under = (c, p) => (norm(c) + '/').startsWith(norm(p) + '/');
const PROJECT = process.env.COST_PROJECT || 'crewflow-cost';
const COST_DIR = process.env.COST_DIR_W;
const MAIN = process.env.COST_MAIN_W;
const RESERVED = new Set((process.env.COST_RESERVED_PORTS || '').split(/\s+/).filter(Boolean));
if (!COST_DIR || !MAIN) { console.error('ISOLATION: COST_DIR_W / COST_MAIN_W not set'); process.exit(1); }

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let m;
  try { m = JSON.parse(raw); } catch { console.error('ISOLATION: compose config is not JSON'); process.exit(1); }
  raw = '';
  const bad = [];
  const ok = [];
  if (m.name !== PROJECT) bad.push(`project name is '${m.name}', expected '${PROJECT}'`);
  for (const [name, v] of Object.entries(m.volumes || {})) {
    if (v.external) bad.push(`volume '${name}' is external`);
    if (!String(v.name || '').startsWith(`${PROJECT}_`)) bad.push(`volume '${name}' resolves to '${v.name}', not ${PROJECT}_*`);
  }
  for (const [name, n] of Object.entries(m.networks || {})) {
    if (n.external) bad.push(`network '${name}' is external`);
    if (n.name !== `${PROJECT}-net`) bad.push(`network '${name}' resolves to '${n.name}', not ${PROJECT}-net`);
  }
  for (const [svc, s] of Object.entries(m.services || {})) {
    if (s.container_name && !s.container_name.startsWith('costaudit-')) bad.push(`${svc}: container_name '${s.container_name}' is not costaudit-*`);
    if (s.privileged) bad.push(`${svc}: privileged`);
    if (s.network_mode) bad.push(`${svc}: network_mode '${s.network_mode}'`);
    if (s.pid) bad.push(`${svc}: pid '${s.pid}'`);
    if (s.ipc && s.ipc !== 'private' && s.ipc !== 'shareable') bad.push(`${svc}: ipc '${s.ipc}'`);
    for (const net of Object.keys(s.networks || {})) if (!(net in (m.networks || {}))) bad.push(`${svc}: undeclared network '${net}'`);
    for (const v of s.volumes || []) {
      if (v.type === 'bind') {
        const desc = `${svc}: bind ${v.source} -> ${v.target}${v.read_only ? ' (ro)' : ' (rw)'}`;
        if (!v.read_only) bad.push(`${desc}: bind mount is writable`);
        if (under(v.source, MAIN) || under(MAIN, v.source)) bad.push(`${desc}: source overlaps the main checkout ${MAIN}`);
        if (!under(v.source, COST_DIR)) bad.push(`${desc}: source is outside the harness folder`);
        if (/docker\.sock|docker_engine/i.test(String(v.source))) bad.push(`${desc}: Docker socket`);
        ok.push(desc);
      } else if (v.type === 'volume') {
        if (!(v.source in (m.volumes || {}))) bad.push(`${svc}: volume '${v.source}' is not declared by the project`);
        else ok.push(`${svc}: volume ${m.volumes[v.source].name} -> ${v.target}`);
      } else if (v.type !== 'tmpfs') {
        bad.push(`${svc}: unsupported mount type '${v.type}'`);
      }
    }
    for (const p of s.ports || []) {
      const pub = String(p.published || '');
      if (p.host_ip !== '127.0.0.1') bad.push(`${svc}: port ${pub}->${p.target} not bound to 127.0.0.1 (host_ip '${p.host_ip || ''}')`);
      if (RESERVED.has(pub)) bad.push(`${svc}: port ${pub} is a reserved dev/test/e2e port`);
      ok.push(`${svc}: port 127.0.0.1:${pub}->${p.target}`);
    }
  }
  for (const l of ok) console.log(`  ok  ${l}`);
  if (bad.length) { for (const b of bad) console.error(`ISOLATION: ${b}`); process.exit(1); }
  console.log(`compose model isolated: ${Object.keys(m.services || {}).length} services, ${Object.keys(m.volumes || {}).length} volumes, ${Object.keys(m.networks || {}).length} network(s)`);
});
