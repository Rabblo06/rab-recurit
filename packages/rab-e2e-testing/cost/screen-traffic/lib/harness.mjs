// Host-side guards and lookups shared by run-load.mjs and web/measure-web.mjs. Only ever talks to the harness's own
// containers (costaudit-pg via `docker exec`, costaudit-api via its published loopback port). Secrets are never printed.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
export const API_PORT = Number(process.env.COST_API_PORT || 23070);
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

let markerChecked = false;
/** Superuser SQL inside the disposable container. Refuses unless the database carries the crewflow-cost marker. */
export function psql(sql) {
  const run = (s) => execFileSync('docker', ['exec', '-i', 'costaudit-pg', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'rab', '-d', 'rab', '-Atq'], { input: s, encoding: 'utf8', env: dockerEnv }).replace(/\r/g, '').trim();
  if (!markerChecked) {
    if (run(`select shobj_description(oid,'pg_database') from pg_database where datname=current_database()`) !== 'crewflow-cost disposable measurement database') throw new Error('refusing: costaudit-pg is not the crewflow-cost disposable cluster');
    markerChecked = true;
  }
  return run(sql);
}

/** The API port must be published by the harness's costaudit-api container (never a dev/test stack on that port). */
export function assertHarnessApi() {
  const owner = execFileSync('docker', ['ps', '--filter', `publish=${API_PORT}`, '--format', '{{.Names}}'], { encoding: 'utf8', env: dockerEnv }).trim();
  if (owner !== 'costaudit-api') throw new Error(`refusing: port ${API_PORT} is published by '${owner || 'nothing'}', not costaudit-api`);
  psql('select 1');
}

export function seedPassword() {
  const file = process.env.COST_SECRETS || 'C:/rab-ai-wt/cost-secrets/cost.env';
  const pw = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('SEED_PW='))?.slice(8);
  if (!pw) throw new Error('SEED_PW missing from the secrets file');
  return pw;
}

/**
 * The approved, upcoming venue request a manager owns whose pipeline shows the most staff with an avatar (so the 60 s
 * avatar-preview poll is exercised); ties broken by start time and id. Deterministic on the deterministic seed.
 */
export function pipelineShiftFor(email) {
  const esc = email.replace(/'/g, "''");
  const id = psql(`select s.id from core.shift s join core."user" m on m.id = s.created_by
    left join core.shift_assignment sa on sa.shift_id = s.id left join core.staff_profile sp on sp.id = sa.staff_profile_id
    left join core."user" su on su.id = sp.user_id
    where m.email = '${esc}' and s.requested_by is not null and s.status not in ('pending_manager_approval','declined','draft') and s.ends_at > now()
    group by s.id, s.starts_at order by count(su.avatar_file_id) desc, s.starts_at, s.id limit 1`);
  if (!id) throw new Error(`no venue-requested shift for ${email}; run seed-screen-traffic.sh`);
  return id;
}
