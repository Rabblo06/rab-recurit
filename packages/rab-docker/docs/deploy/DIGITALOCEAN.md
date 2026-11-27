# DigitalOcean + Cloudflare: production runbook

Owner decisions 24, 25, 26 and 53 (accepted 2026-11-21, `docs/DECISIONS-PENDING.md`): DigitalOcean Managed PostgreSQL in
London; the full hardened compose file under plain `docker compose`, `CREWFLOW_RUNTIME_ISOLATION=enforce`, Redis with a
password, a Cloudflare-only firewall; no standby node yet; managed daily backups + 7-day point-in-time restore + a weekly
restore drill.

**Status: prepared, not rehearsed.** Written 2026-11-21 against `main`. Nothing here has run on DigitalOcean yet: no
account, cluster, droplet, DNS record or certificate was created, and no credential was used. Lines marked **to
confirm** must be checked in the rehearsal (§4.10) before go-live. DigitalOcean is "expected to work" with the setup flow
(`OWNER-LOGIN-DEPLOYMENT.md` §4a, `docs/DEPLOY-OWN-DATABASE.md`), never tested.

| File | What it is |
|---|---|
| `packages/rab-docker/docker-compose.image.yml` | The production stack (unchanged): every hardening key, isolation enforce, the Redis ACL |
| `packages/rab-docker/digitalocean/docker-compose.digitalocean.yml` | The DigitalOcean override: bundled db pinned off; fixed default subnet for the edge |
| `packages/rab-docker/digitalocean/env/compose.env.example` | compose.env with the DigitalOcean choices made (mode b, `doadmin`, port 25060, verify-full) |
| `packages/rab-docker/digitalocean/env/database.env.example` | the cluster CA path and the database name |
| `packages/rab-docker/digitalocean/env/runtime.env.digitalocean.example` | the DigitalOcean lines to set in a copy of `env/runtime.env.example` |
| `packages/rab-docker/digitalocean/env/redis-users.acl.example` | the Redis ACL with a password-protected `default` user |
| `packages/rab-docker/digitalocean/edge/Caddyfile.example` | the TLS edge on the droplet host (Origin CA, per-hostname Authenticated Origin Pulls with our own client CA, `strict_sni_host`) |
| `packages/rab-docker/digitalocean/verify-digitalocean.cjs` | the gate: templates, the rendered shape, and lints for the real env / ACL files |

---

## 1. What runs where

```
 browser / phone ──HTTPS──► Cloudflare (DNS, proxy, TLS edge, Full (strict))
                                │  HTTPS + per-hostname Authenticated Origin Pulls (OUR client cert, mTLS)
                                ▼
 DigitalOcean lon1 ── Cloud Firewall: 80/443 from Cloudflare only, 22 from your IP only ──────────────────────────────
 │ Droplet (Basic 4 vCPU / 8 GB, Ubuntu 24.04 LTS)                                                                    │
 │   Caddy (host) :443 ──► 127.0.0.1:3000 ──► rab-api      ┐ docker compose, network 172.16.30.0/24                   │
 │                                            rab-worker    │ (rab-api sees Caddy as 172.16.30.1 = TRUSTED_PROXY_CIDRS) │
 │                                            rab-redis     │ ACL, password, never published                          │
 │                                            db-setup / db-harden (one-shot, the only holders of the admin URL)     │
 │                         VPC (private) │ TLS verify-full, port 25060                                                │
 │ Managed PostgreSQL 16, 2 GiB / 1 vCPU, trusted source = the droplet only, daily backups + 7-day PITR               │
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Files: Cloudflare R2 (or Spaces lon1). Front end: Cloudflare (Pages / Workers), unchanged by this runbook.
```

The droplet holds no database. Redis holds queued jobs (AOF), so the droplet's own daily backup still matters.

## 2. Monthly cost (list prices re-checked 2026-11-21; USD, before UK VAT)

| Item | Price | Source (checked 2026-11-21) |
|---|---|---|
| Droplet, Basic Regular 4 vCPU / 8 GiB | $48.00 | digitalocean.com/pricing/droplets |
| Droplet backups, daily (30 % of the droplet) | $14.40 | same page ("20 % weekly or 30 % daily") |
| Managed PostgreSQL, 2 GiB / 1 vCPU, single node (30-60 GiB storage, 7-day PITR) | $30.45 | digitalocean.com/pricing/managed-databases; PITR: docs …/postgresql/details/limits/ |
| Spaces (250 GiB + 1 TiB transfer), or Cloudflare R2 (10 GB free) | $5.00 (or $0) | digitalocean.com/pricing/spaces-object-storage |
| Cloudflare Free (DNS, proxy, Universal SSL, Origin CA, Authenticated Origin Pulls) | $0 | developers.cloudflare.com/ssl/edge-certificates/universal-ssl/; AOP "Free: Yes" (…/authenticated-origin-pull/; per-hostname has no separate row: **to confirm** on the Free plan) |
| **Total** | **$97.85, about $98** (about $93 with R2 instead of Spaces) | matches decision 24 |

**Two findings from the re-check that change item 24-26's assumptions (owner to note):**

1. **"Add a standby later for about $30" is no longer possible on a new Standard cluster.** DigitalOcean's PostgreSQL
   pricing page (last updated 2026-09-30): "Beginning 15 October 2026 for new accounts and 30 November 2026 for all
   accounts, new Standard Edition clusters … cannot use plans with more than 4 GiB of RAM or add standby or read-only
   nodes." A new account is affected already. High availability then means an **Advanced Edition** cluster, from
   **$130.00/month** (8 GiB / 2 vCPU primary; a standby bills at the primary's rate, so about $260/month with one standby).
   Decision 26 (b, "not yet") still stands, but its "+$30" no longer does: plan for Advanced Edition (or a restore-based
   recovery with the RTO that implies) when the first paying customer goes live.
2. **The 2 GiB plan has ONE vCPU; the load test's database had two and still saturated at the 2x spike.** At the 1.0x
   peak, with the fixes, the database used a median of about 120 % CPU (1.2 cores; `LOAD-TEST.md` "Resources"). The
   1-vCPU plan would likely be saturated at the modelled peak. The modelled peak is a synthetic estimate (decision 52:
   re-measure with real traffic), so starting on 2 GiB is reasonable, but resize to **4 GiB / 2 vCPU ($60.90; 97
   connections)** before a busy period or as soon as database CPU stays above 70 %. DigitalOcean resizes upward in place
   (a short reconnect).

Other prices: Managed PostgreSQL 1 GiB / 1 vCPU $15.15 (22 connections: the API refuses to start on it, §7); extra
database storage $0.215/GiB/month; Spaces overage $0.02/GiB stored, $0.01/GiB transferred.

## 3. What only you (the owner) can do

Agents never create accounts, hold credentials, or change DNS. These steps are yours:

1. **Accounts:** create the DigitalOcean account (turn on its 2FA, add a billing alert), and confirm the Cloudflare
   account that holds `rabworkspaceteams.co.uk` (its 2FA on). Create the DigitalOcean project "Crewflow", region London.
2. **Resources:** create the VPC, the database cluster, the droplet, the Cloud Firewall, and the bucket (§4.2-4.5).
3. **Secrets:** generate every password ON THE SERVER (`openssl rand -hex 32`), write them only into
   `/etc/crewflow/` (§4.7), and keep an offline copy in your password manager. Never paste one into chat, a ticket, a PR
   or a commit. The secrets are: the `doadmin` URL, the `crewflow_owner` password, `APP_SECRET`, the two Redis passwords,
   the SMTP/Resend key, the bucket key, the Cloudflare Origin CA private key.
4. **DNS and TLS:** the Cloudflare records, SSL mode, Origin CA certificate, and per-hostname Authenticated Origin Pulls
   with a client certificate you generate (its CA key kept offline) (§4.8-4.9).
5. **MFA flags:** set `AUTH_MFA_ENFORCE_ORGANISATION_OWNER` / `_INITIAL_MANAGER` when you are ready (decision 2, step 2);
   agents never change them.
6. **First admin:** receive the activation email, activate, enrol your authenticator (§4.12).
7. **Cutover:** switch the `api` record, then turn OpenShip off and, once happy, delete the Neon project (§4.13).
8. **Weekly:** run (or watch) the restore drill and keep its record (§5.2).

## 4. Steps, in order

### 4.1 Account and project

- DigitalOcean: project "Crewflow" (environment Production), default region **LON1**. Account 2FA on. Team members only
  as needed; nobody else gets the database's Connection Details page.
- Cloudflare: the zone `rabworkspaceteams.co.uk` is active (Full setup, Cloudflare nameservers).

### 4.2 VPC

- Networking → VPC → Create: region **LON1**, name `crewflow-lon1`, default IP range (a 10.x /20). The droplet and the
  database go into this VPC so they talk over the private network.

### 4.3 Managed PostgreSQL (decision 24 a)

1. Databases → Create: **PostgreSQL 16** (the bundled db, the load test and the restore drill all ran 16; the image also
   supports 17 and 18), datacenter **LON1**, VPC `crewflow-lon1`, **Standard Edition, 2 GiB / 1 vCPU, single node**,
   name `crewflow-db`. Encryption at rest, daily backups and 7-day PITR are included.
2. **Users & Databases → Add database `crewflow`** (never use `defaultdb` for the app). Do NOT create `crewflow_owner`
   here: db-setup creates it with the password you generate (mode b).
3. **Overview → Connection Details:** choose **VPC network**, database `crewflow`, user `doadmin`, "Connection string".
   Note it for compose.env, change `sslmode=require` to `sslmode=verify-full`. The port must be **25060** (direct).
   Never use the pool port **25061** or a "Connection pool" (db-setup refuses a pooler; the DigitalOcean lint refuses the
   port by number; #258 stays parked, decision 14).
4. **Download CA certificate** (Standard Edition provides it) → later `/etc/crewflow/do-pg-ca.crt` on the droplet.
5. **Settings → Trusted sources:** after the droplet exists, add **only the droplet** (by name). Remove any "all IPv4"
   entry. This is decision 25.4's "database reachable from the server only".
6. **Settings → Maintenance window:** a quiet hour (e.g. Sunday 03:00 UTC).
7. Optional belt and braces for the load test's JIT finding (§7): if the cluster's advanced configuration offers `jit`,
   set it off. **To confirm** it exists on Standard Edition. This is cluster configuration, not SQL, and does not touch
   the posture goldens (never use `ALTER ROLE ... SET jit`, which the semantic-posture boot gate refuses).
8. **To confirm in the rehearsal:** that verify-full succeeds against the **private** host name. If DigitalOcean's
   certificate does not cover it, db-setup refuses (fail closed); use the public host name instead, still with trusted
   sources limited to the droplet.

### 4.4 Droplet

1. Droplets → Create: **LON1**, VPC `crewflow-lon1`, **Ubuntu 24.04 LTS x64**, **Basic, Regular, 4 vCPU / 8 GiB**,
   **SSH key only** (no password), **daily backups ON**, monitoring ON, hostname `crewflow-prod-1`.
2. Host hardening (as root once, then never as root again):
   - a sudo user with your SSH key; `PermitRootLogin no`, `PasswordAuthentication no` in sshd; restart sshd;
   - `apt install unattended-upgrades` (security updates on);
   - timezone UTC; NTP on (the default).
3. **Docker Engine 28 or later + Compose plugin v2.24 or later** from Docker's own apt repository. Engine 28 is required:
   before it, a port published on `127.0.0.1` could still be reached by another host on the same network by routing
   packets for `127.0.0.1` at the droplet (Engine 28 drops them), which would let a neighbour in the VPC reach rab-api
   around Caddy. Compose 2.24 is needed for `env_file: required` and `depends_on: restart`. Check with
   `docker version --format '{{.Server.Version}}'`. Add nobody to the `docker` group (it is root-equivalent): use `sudo`.
4. **Caddy 2.8+** from the official Caddy apt repository (§4.9).
5. **Node.js 24** (only for the lints; nothing of the app runs on the host): the official binary or NodeSource.
6. The release checkout, read-only, at the approved commit:
   `sudo git clone https://github.com/Rabblo06/rab-recurit /opt/crewflow/release && cd /opt/crewflow/release && sudo git checkout <release-commit>`.
   Only the compose files and the gate scripts are used from it; the app runs from the image digest.

### 4.5 Cloud Firewall (decision 25.4)

Networking → Firewalls → Create `crewflow-prod`, apply to the droplet:

| Direction | Protocol / port | Sources / destinations |
|---|---|---|
| Inbound | TCP 443 | Cloudflare IPv4 + IPv6 ranges (below) |
| Inbound | TCP 80 | the same Cloudflare ranges (Caddy answers only with a redirect; you may leave 80 closed, see note) |
| Inbound | TCP 22 | **your own public IP /32 only** |
| Inbound | everything else | none (UDP 443 / HTTP/3 stays closed) |
| Outbound | all TCP/UDP | all (image pulls, SMTP/Resend, R2, the database over the VPC, apt, NTP) |

Cloudflare ranges, snapshot 2026-11-21 (always re-copy from https://www.cloudflare.com/ips-v4 and
https://www.cloudflare.com/ips-v6 on the day):
IPv4 `173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20
188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22`;
IPv6 `2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32`.

- Note on port 80: with Cloudflare's "Always Use HTTPS" nothing legitimate reaches the origin on 80. Decision 25.4 says
  80/443; closing 80 is stricter and loses nothing. Your choice; the Caddyfile handles both.
- Docker publishes rab-api on **127.0.0.1 only**, so the firewall is the second fence, not the first. Never change
  `CREWFLOW_API_BIND`.
- When your home IP changes, update the SSH rule (or use the DigitalOcean web console).
- Re-check the Cloudflare ranges monthly (§8). A missing new range only refuses some Cloudflare traffic; it never lets
  anyone else in.

### 4.6 Redis password (decision 25.3)

Redis runs in compose (Managed Valkey is not needed, decision 24 notes). On the droplet:

```sh
sudo install -d -m 0700 -o root -g root /etc/crewflow /etc/crewflow/secrets
APP_PW="$(openssl rand -hex 32)"      # goes into REDIS_URL (runtime.env)
DEF_PW="$(openssl rand -hex 32)"      # the default user's password: hashed below, then thrown away
APP_HASH="$(printf %s "$APP_PW" | sha256sum | cut -d' ' -f1)"
DEF_HASH="$(printf %s "$DEF_PW" | sha256sum | cut -d' ' -f1)"
unset DEF_PW
```

Copy `digitalocean/env/redis-users.acl.example` to `/etc/crewflow/secrets/redis-users.acl` (root:root 0644: the Redis
container's uid 999 must read it), put `$DEF_HASH` in the `default` line and `$APP_HASH` in the `crewflow` line, then
`unset DEF_HASH APP_HASH`. Keep `$APP_PW` for runtime.env (next step), then `unset APP_PW`.

Why the `default` user is ON with a password, not OFF: decision 25.3, and the 2026-11-02 finding that a `default` user
without command permissions makes Redis 7.4 silently drop BullMQ data replayed from the AOF on restart. The `default`
user gets exactly the app user's permissions (what replay needs, nothing more) and a password nobody uses. Lint it:

```sh
sudo node /opt/crewflow/release/packages/rab-docker/digitalocean/verify-digitalocean.cjs --lint-acl /etc/crewflow/secrets/redis-users.acl
```

### 4.7 The env files (secrets stay on the server)

| File | From | Mode |
|---|---|---|
| `/etc/crewflow/compose.env` | `digitalocean/env/compose.env.example` | root:root 0600 |
| `/etc/crewflow/do-pg-ca.crt` | the cluster's "Download CA certificate" | root:root 0644 |
| `/etc/crewflow/secrets/database.env` | `digitalocean/env/database.env.example` | root:root 0600 |
| `/etc/crewflow/secrets/runtime.env` | `env/runtime.env.example`, then the lines of `digitalocean/env/runtime.env.digitalocean.example` | root:root 0600 |
| `/etc/crewflow/secrets/redis-users.acl` | §4.6 | root:root 0644 |

- compose.env: the `doadmin` URL (VPC host, `/crewflow`, port 25060, `sslmode=verify-full`), `PG_DATABASE_APP_PASSWORD`
  (`openssl rand -hex 32`), the same host/port/database in `PG_DATABASE_HOST` / `_PORT` / `_NAME`,
  `CREWFLOW_BUNDLED_DB=0`, the image digest, the Redis image digest.
- database.env: optionally a deployment id (`uuidgen`), recommended so a restore-drill copy can never pass as production.
- runtime.env: `APP_SECRET` (`openssl rand -hex 48`), `REDIS_URL=redis://crewflow:<APP_PW>@rab-redis:6379`,
  `TRUSTED_PROXY_CIDRS=172.16.30.1/32`, the https URLs, email, the bucket (a key scoped to that one bucket),
  `CREWFLOW_AUDIT_SINK=stdout`, `AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true` (decision 2, step 1).
- **Workspace host routing (option B).** `WORKSPACE_BASE_DOMAIN=rabworkspaceteams.co.uk` and
  `WORKSPACE_HOST_ROUTING_ENABLED=true` are accepted runtime.env values. `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED`, the
  third part of option B as set on OpenShip on 2026-11-20, is **refused by the env-file lint** (it is on the "separate
  owner approval" list in `compose-owner-login.cjs`). This runbook does not relax that; see open question Q1 (§10).

Lint every file (names and reasons only, never a value):

```sh
R=/opt/crewflow/release/packages/rab-docker
for k in compose database runtime; do
  f=/etc/crewflow/$([ $k = compose ] && echo compose.env || echo secrets/$k.env)
  sudo node $R/scripts/compose-owner-login.cjs --lint-env-file $k "$f"
  sudo node $R/digitalocean/verify-digitalocean.cjs --lint-env-file $k "$f"
done
```

### 4.8 Cloudflare DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `api` | the droplet's public IPv4 | **Proxied** (orange cloud) |
| AAAA | `api` | the droplet's IPv6 (only if you enabled IPv6 on the droplet) | Proxied |
| (wildcard) | `*` | where the **front end** serves workspace hosts (`<label>.rabworkspaceteams.co.uk`) | Proxied |

- The explicit `api` record always wins over `*` in DNS. If the front end uses a wildcard **Workers route**
  (`*.rabworkspaceteams.co.uk/*`), add an exclusion route `api.rabworkspaceteams.co.uk/*` with no Worker, so API traffic
  never reaches the front end. Reserved labels (`api`, `www`, `admin`, `app`, ...; `@rab/shared` RESERVED_SUBDOMAINS)
  are never workspaces.
- Universal SSL (free) covers the apex and first-level names (`api.` and `<label>.`), so the wildcard needs no paid
  certificate. A deeper name (`x.y.rabworkspaceteams.co.uk`) would not be covered.
- Before the cutover (§4.13) the `api` record still points where it points today; you switch it last.

### 4.9 TLS: Cloudflare Full (strict) to Caddy

1. SSL/TLS → Overview: **Full (strict)**. Edge Certificates: **Always Use HTTPS** on, **Minimum TLS 1.2**, TLS 1.3 on.
   HSTS: turn it on only after a week of clean running (it cannot be undone quickly for browsers that saw it).
2. SSL/TLS → Origin Server → **Create Certificate** (RSA or ECC, hostnames `api.rabworkspaceteams.co.uk`, 15 years).
   Save the certificate as `/etc/caddy/tls/origin.crt` and the private key (shown once) as `/etc/caddy/tls/origin.key`,
   both `root:caddy 0640`.
3. **Per-hostname Authenticated Origin Pulls with OUR OWN client certificate** (security review of #332). Never the
   Cloudflare-provided certificate (what global and default zone-level Authenticated Origin Pulls present): it is
   SHARED by every Cloudflare customer, so trusting its CA would admit anyone who points their own proxied zone at the
   droplet IP (with a Host / SNI override) and lets them skip our zone's WAF, rate-limit and bot rules. The firewall and Caddy's `remote_ip` rule cannot tell zones apart either:
   only this certificate proves "our zone". On a trusted machine (your laptop, not the droplet):

   ```sh
   umask 077
   openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 \
     -subj '/CN=Crewflow AOP CA' -addext 'basicConstraints=critical,CA:TRUE' \
     -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout crewflow-aop-ca.key -out crewflow-aop-ca.pem
   openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -subj '/CN=api.rabworkspaceteams.co.uk origin pull' \
     -keyout aop-client.key -out aop-client.csr
   printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > aop-client.ext
   openssl x509 -req -in aop-client.csr -CA crewflow-aop-ca.pem -CAkey crewflow-aop-ca.key -CAcreateserial \
     -days 825 -extfile aop-client.ext -out aop-client.crt
   ```

   - Cloudflare → SSL/TLS → Origin Server → Authenticated Origin Pulls → **Per-hostname** → Upload certificate: paste
     `aop-client.crt` and `aop-client.key`, associate **only** `api.rabworkspaceteams.co.uk`, save. (Or the API:
     `POST /zones/{zone_id}/origin_tls_client_auth/hostnames/certificates`, then enable the hostname.) Leave zone-level
     Authenticated Origin Pulls OFF.
   - Copy only `crewflow-aop-ca.pem` (the public CA certificate) to the droplet as
     `/etc/caddy/tls/crewflow-aop-ca.pem` (root:caddy 0644). Store `crewflow-aop-ca.key` OFFLINE (password manager /
     encrypted USB); delete `aop-client.key` from the laptop after the upload (Cloudflare holds it). Never put any of
     them in the repository or chat.
   - Renewal: the client certificate expires after 825 days; Cloudflare emails 30 and 14 days before. Sign a new one
     with the same CA and upload it, then remove the old one.
4. Copy `digitalocean/edge/Caddyfile.example` to `/etc/caddy/Caddyfile`, replace `<api-host>` with
   `api.rabworkspaceteams.co.uk`, then:
   `sudo caddy validate --config /etc/caddy/Caddyfile`,
   `sudo node $R/digitalocean/verify-digitalocean.cjs --lint-caddyfile /etc/caddy/Caddyfile` (refuses a missing
   `strict_sni_host on`, any mode but `require_and_verify`, a trust pool named like or issued by Cloudflare, a non-CA
   trust pool, a non-loopback upstream), and `sudo systemctl reload caddy`.
5. Check from your laptop after the cutover: `curl -sI https://api.rabworkspaceteams.co.uk/healthz` → 200 through
   Cloudflare; and directly against the droplet IP (`curl -k --resolve api.rabworkspaceteams.co.uk:443:<droplet-ip> ...`)
   → refused by the firewall (and, if the firewall were open, by the TLS client-certificate check).

### 4.10 Rehearsal with test data (decision step 4) — before go-live

On a **test** cluster (created and destroyed by you; about one hour; DigitalOcean bills by the hour) or on the real
cluster before any real data:

1. The gate with the real files (compose.env, and through its `CREWFLOW_SECRETS_DIR` database.env, runtime.env and
   redis-users.acl, plus the Caddyfile and its trust pool):
   `sudo node $R/digitalocean/verify-digitalocean.cjs --environment --env-file /etc/crewflow/compose.env --caddyfile /etc/caddy/Caddyfile`
2. `C="sudo docker compose --env-file /etc/crewflow/compose.env -f $R/docker-compose.image.yml -f $R/digitalocean/docker-compose.digitalocean.yml"`;
   `$C config --quiet && $C pull && $C up -d`.
3. Expected: `db-setup` exits 0 (creates `crewflow_owner`, pre-hashed first; **to confirm** that DigitalOcean accepts
   the pre-hashed form, otherwise the documented plain-text fallback over verified TLS applies); rab-api migrates and
   becomes healthy; `api-prestart: runtime isolation as declared: ... mode=enforce` and
   `[worker-isolation] runtime isolation as declared: ... mode=enforce`; `db-harden` exits 0 after the ledger is
   complete (CREATEROLE removed). `$C ps -a`, `$C logs db-setup db-harden rab-api rab-worker | less`.
4. A green posture: the API starts only if the semantic-posture and RLS boot gates pass, so a healthy `/healthz` is the
   posture check. **To confirm:** `/healthz` shows no `upgradeFailed`.
5. **To confirm:** the peer address rab-api logs for a request through Caddy is `172.16.30.1` (so
   `TRUSTED_PROXY_CIDRS=172.16.30.1/32` is right, and a sign-in rate limit applies per real client, not to everyone).
6. **To confirm:** the budget check passes (the API logs its connection budget; 40 of 47 expected).
7. **Must fail: a request through ANOTHER Cloudflare zone** (proves the per-hostname client certificate is what admits
   traffic, not "any Cloudflare edge"). In a second zone you control (or a free test zone), add a proxied A record, e.g.
   `aop-test.<other-zone>` → the droplet IP, and an Origin Rule on it that overrides the Host header (and, if your plan
   offers it, the SNI) to `api.rabworkspaceteams.co.uk`. Then `curl -sI https://aop-test.<other-zone>/healthz` must
   **fail** (Cloudflare 525/526: the origin refused the TLS handshake, because that zone presents Cloudflare's shared
   certificate, not ours; or 421 from `strict_sni_host` if the SNI and Host differ). It must never return 200. Delete
   the test record afterwards. Also: `curl -sI https://api.rabworkspaceteams.co.uk/healthz` → 200 (our zone works).
8. The first **restore drill** (§5.2), with its RTO and RPO recorded.

### 4.11 First production deploy

Requires (decision steps 2 and 6): #211 merged (old database setting names refused), 0.7.0 shipped (item 16), the image
digest approved, and the load-test fixes in the image (§7). Then the same commands as §4.10 steps 1-3 on the
production values. Keep the previous digest in a comment in compose.env with its date and `enforce=yes`.

### 4.12 First platform admin, with MFA

1. runtime.env already has `AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true` (without it the API refuses to create the admin).
2. Put `BOOTSTRAP_ADMIN_EMAIL=<your email>` in compose.env (rab-api only), `$C up -d`.
3. Log line `First platform administrator created from BOOTSTRAP_ADMIN_EMAIL, pending activation.`; rab-worker sends the
   activation email (valid 24 hours).
4. Activate, set a password, **enrol your authenticator** (required at that sign-in), store the recovery codes offline.
5. Remove `BOOTSTRAP_ADMIN_EMAIL` from compose.env, `$C up -d`. Later starts log "A platform administrator already
   exists".
6. Decision 2, step 2 (before real data): you set `AUTH_MFA_ENFORCE_ORGANISATION_OWNER=true` and
   `AUTH_MFA_ENFORCE_INITIAL_MANAGER=true` in runtime.env, then `$C up -d`.

### 4.13 Cutover from OpenShip (decision step 7: a fresh install, no data migration)

OpenShip/Neon holds test data only, so nothing is copied.

1. DigitalOcean is up, healthy, rehearsed, first admin active (§4.10-4.12).
2. Cloudflare: change the `api` record to the droplet IP (proxied). Proxied records switch within seconds; clients keep
   the same hostname, so the web console and the phone app need no new build (their API URL is unchanged).
3. Watch for 30 minutes: `$C logs -f rab-api`, Caddy's `/var/log/caddy/api-access.log`, Cloudflare Analytics.
   Everyone signs in again (a new `APP_SECRET` and a new database).
4. **You:** turn the OpenShip services off (do not delete them yet). After you are happy (suggest one week), delete the
   OpenShip project and then the Neon project. Agents never touch either.

### 4.14 Rollback

| Situation | Action |
|---|---|
| Before the DNS switch | Nothing to roll back; OpenShip keeps serving. Fix and retry. |
| After the switch, the app misbehaves, schema unchanged | Previous image digest in compose.env, `$C pull && $C up -d` (both services go back together). Only a digest whose start lines showed `mode=enforce` (`MIGRATION-AND-ROLLBACK-PLAN.md` §6, R-3). The first DigitalOcean release has no predecessor: roll forward. |
| After the switch, DigitalOcean itself fails in the first week | Point `api` back at OpenShip (still off, not deleted: turn it on first). It serves the OLD test database: anything written on DigitalOcean meanwhile is not there. A decision for you, not automatic. |
| Data loss or a bad migration | Point-in-time restore into a NEW cluster (§5.1), rebind the deployment identity (R-7), set the new host in compose.env, `$C up -d`. Revoke all sessions afterwards. |
| The droplet is lost | Create a droplet from its latest daily backup (or a new one plus §4.4-4.9), same firewall, same trusted source; the database is unaffected. Queued jobs since the backup are lost; the sweeps re-create the time-based ones. |

## 5. Backups (decision 53)

### 5.1 What exists

- **Managed PostgreSQL:** daily backups and **point-in-time restore over the last 7 days** (included in the plan).
  A restore always goes to a **new** cluster (Databases → the cluster → Backups → Restore / "Fork"; choose a time).
  RPO: seconds to minutes within the 7 days. The restored cluster is a copy: it carries the source's roles, including
  `crewflow_owner` with its password, and gets its own host name (download its CA too; it may be the same project CA). **To confirm:** whether its `doadmin` password
  differs (read it from the new cluster's Connection Details).
- **Droplet daily backups** (30 %): the host, Redis's AOF, the Caddy and Docker configuration. Not a database backup.
- **Secrets:** your password manager (offline copy of `/etc/crewflow/` values). Without `APP_SECRET`, stored encrypted
  secrets and every session are unrecoverable.
- Not in decision 53, so not set up here: an off-site logical dump (`MIGRATION-AND-ROLLBACK-PLAN.md` §5.1, age-encrypted
  to R2). `RESTORE-DRILL.md` §4 recommends it before real payroll data; see Q3 (§10).

### 5.2 Weekly restore drill (using `packages/rab-docker/docs/hardening/RESTORE-DRILL.md`)

Every week (suggest Monday morning), about 30 minutes, about $0.05 of cluster time:

1. **Restore:** the production cluster → Backups → restore to a new cluster at "now minus 1 hour", name
   `crewflow-drill-YYYYMMDD`, same region, VPC, plan. Start the RTO clock. Trusted sources: the droplet only.
2. **Never point production at it, and never start a Worker against it** (a Worker would send real emails and
   notifications from the copy). Drill stack, separate project name, API only:
   - a drill directory `/etc/crewflow-drill/` (root 0700) with its own compose.env (a copy of production's with the
     drill cluster's host in `PG_ADMIN_URL` / `PG_DATABASE_HOST`, a NEW `PG_DATABASE_APP_PASSWORD` plus
     `CREWFLOW_ROTATE_APP_PASSWORD=1` so the copy never reuses the source credential (`RESTORE-DRILL.md` §2 step 2),
     `CREWFLOW_API_HOST_PORT=3900`, `CREWFLOW_SECRETS_DIR=/etc/crewflow-drill/secrets`, `CREWFLOW_PG_CA_FILE` = the
     drill cluster's downloaded CA), and copies of the three secret files;
   - the drill database.env: with a deployment id declared, the copy refuses every process until rebound as a
     throwaway (`MIGRATION-AND-ROLLBACK-PLAN.md` §5.2 step 4) — that refusal is the expected first result; rebind, or
     run the drill without a deployment id in the drill database.env and record that you did;
   - **without** the DigitalOcean override (its fixed subnet would collide with production's network; the drill stack
     gets its own Docker subnet; compose.env's `CREWFLOW_BUNDLED_DB=0` keeps the bundled db off):
     `sudo docker compose -p crewflow-drill --env-file /etc/crewflow-drill/compose.env -f $R/docker-compose.image.yml up -d rab-redis db-setup rab-api`
     (no rab-worker, no db-harden). Check it with `curl -s http://127.0.0.1:3900/healthz` on the droplet.
3. **Verify** (`RESTORE-DRILL.md` §2 step 5 and plan §5.2 step 3): rab-api reaches healthy (that means the
   semantic-posture and RLS boot gates passed on the copy), the migration ledger count and the newest timestamp equal
   production's, and the row counts of a few business tables are within the hour's writes. Stop the clock: that is the
   **RTO**. The chosen restore time vs the newest row is the **RPO**.
4. **Destroy:** `sudo docker compose -p crewflow-drill down -v`, delete the drill cluster, `sudo rm -rf /etc/crewflow-drill`.
5. **Record** date, restore point, RTO, RPO, any refusal, in the drill log (e.g. `docs/evidence/restore-drills/`).

Notes: `RESTORE-DRILL.md` found that a **logical** (`pg_dump`) restore onto a new cluster trips the semantic-posture
boot gate (role order of one policy; MEDIUM, fix proposed there). A DigitalOcean restore is a **physical** copy, so the
stored order is preserved and it should not trip; **to confirm** in the first drill. If it does trip, the fix in
`RESTORE-DRILL.md` must land before go-live.

## 6. The DigitalOcean override, explained

`docker-compose.digitalocean.yml` changes two things and nothing else:

- `db` → `deploy.replicas: 0`. The managed cluster is the database. compose.env must also say `CREWFLOW_BUNDLED_DB=0`;
  if it forgets, db-setup waits for a db that never starts and exits 70, so rab-api never starts (fail closed).
- `networks.default` → subnet `172.16.30.0/24`, gateway `172.16.30.1`. Caddy on the host connects to `127.0.0.1:3000`;
  Docker forwards that connection from the bridge gateway, so rab-api sees `172.16.30.1`. Fixing the subnet makes
  `TRUSTED_PROXY_CIDRS=172.16.30.1/32` known before the first start. Only that peer's `CF-Connecting-IP` is believed.
  172.16.30.0/24 is outside Docker's default address pools (172.17.0.0/16-172.31.0.0/16, 192.168.0.0/16), so Docker
  never gives it to another network, and outside DigitalOcean's VPC ranges (10.x).
  **Caution:** every process on the host (and any container with `network_mode: host`, such as a monitoring agent) that
  connects to `127.0.0.1:3000` also arrives as `172.16.30.1` and is trusted the same way: it can choose the client
  address rab-api records and rate-limits on. Run nothing else on the droplet that sends requests to rab-api; install
  monitoring agents that only read metrics.

Everything else (non-root users, read-only roots, `cap_drop: ALL`, no-new-privileges, PID/memory/CPU limits, tmpfs, the
env files, the `depends_on` conditions, `CREWFLOW_RUNTIME_ISOLATION=enforce`, the Redis ACL, the loopback-only API port,
the OpenShip import guard) comes from `docker-compose.image.yml`. The gates that prove it (CI, every PR):
`compose-owner-login.cjs` (combo `digitalocean`), `compose-one-image.cjs`, and `verify-digitalocean.cjs` with its tests.

## 7. What the DigitalOcean shape carries from the M9 load test (`LOAD-TEST.md`, PR #313)

| Item | Setting | Where | Status |
|---|---|---|---|
| **JIT off** for tenant transactions | `set_config('jit','off', true)` in `TenantContextService.bindGucsSql` | application code (decision 49 a) | Proposed diff in `LOAD-TEST.md` §4.1; must be in the image before go-live. **Never** `ALTER ROLE crewflow_owner SET jit = off` (the semantic-posture boot gate refuses it). Optional extra: the cluster's `jit` setting off (§4.3 step 7). |
| API pool | `PG_POOL_MAX_CONNECTIONS=9`, `PG_EXPECTED_API_POOL_MAX=9` | runtime.env | The load test ran 10 (41 of 47); 9 is the reviewed template. The pool was not the bottleneck once JIT was off. |
| Worker pool | `PG_POOL_MAX_CONNECTIONS: "12"` | committed on rab-worker | unchanged |
| Instances | one API, one Worker (`PG_EXPECTED_*_INSTANCES=1`) | runtime.env | stop-then-start (C5) |
| Connection budget | 40 of 47 (2 GiB plan) | the API's boot check; `verify-digitalocean.cjs` | the 1 GiB plan (22) is refused; 4 GiB has 97 |
| Two indexes | `attendance_workspace_clock_in_idx`, `email_outbox_attachment_file_idx` | draft #312 (owner SQL review) | must be in the image before go-live |
| Refresh pool-deadlock fix | `isPlatformAdminTx(manager, ...)` in `rotate()` | its own PR (HIGH) | must be in the image before go-live |
| Database CPU | 2 vCPU at the modelled peak | the cluster plan | §2 finding 2: start on 2 GiB / 1 vCPU, resize to 4 GiB / 2 vCPU early |
| API memory | 1024m (the load test's API used 0.8 GB with the fixes) | compose.env | unchanged |

## 8. Operations

- **Deploy:** gate (`--environment ... --caddyfile /etc/caddy/Caddyfile`), `$C pull && $C up -d`. Never scale rab-api; never a second stack on the same
  database (except the API-only drill stack against a drill copy).
- **Logs:** the audit sink is `stdout`, which is compliant only with an **off-host, append-only** log shipper collecting
  rab-api and rab-worker (BC-07). Choose one before go-live (Q2, §10). Container logs are capped at 10 MB × 5.
- **Monthly:** re-check Cloudflare's IP ranges against the firewall and the Caddyfile; `apt` reboot if required; review
  the droplet and database metrics (CPU, connections, disk).
- **Certificates:** the Origin CA certificate lasts 15 years; the Cloudflare edge certificate renews itself; the
  per-hostname Authenticated Origin Pulls client certificate expires after 825 days (Cloudflare warns 30 and 14 days
  before; re-sign with the offline CA and upload, §4.9 step 3); the cluster CA comes with the cluster (a new cluster
  after a restore has its own: download it).
- **Rotate:** crewflow_owner (`OWNER-LOGIN-DEPLOYMENT.md` "Rotate the crewflow_owner password"), Redis (new hash in the
  ACL, new `REDIS_URL`, `$C up -d --force-recreate rab-redis rab-api rab-worker`), `doadmin` (reset it in the cluster's
  Users page, update `PG_ADMIN_URL`; only db-setup / db-harden use it).

## 9. Security notes (what each fence is for)

- **Database:** reachable only from the droplet (trusted sources), only over TLS verify-full against the cluster's own
  CA, only on the direct port; the admin URL reaches only the one-shot db-setup and db-harden; rab-api and rab-worker
  run as `crewflow_owner` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS, CREATEROLE removed by db-harden).
- **Containers:** the full H1-H6 hardening plus `enforce`: if Docker ever failed to apply a control, the API and the
  Worker refuse to start rather than run weakened.
- **Redis:** never published; ACL with passwords; `noeviction` and AOF so jobs are not silently lost.
- **Edge:** what proves a request came through OUR Cloudflare zone is only the per-hostname client certificate
  (signed by our own CA; Caddy `require_and_verify` against that CA alone; `strict_sni_host on`). The Cloud Firewall and
  Caddy's `remote_ip` rule admit every Cloudflare customer and are outer filters only; Cloudflare's provided
  origin-pull certificate would be no better (it is shared by all customers). With the client certificate, `CF-Connecting-IP` is set by
  our zone, and rab-api trusts it only from `172.16.30.1`. Host processes reaching `127.0.0.1:3000` are trusted too
  (§6 caution). Docker Engine 28+ keeps the loopback-published port unreachable from neighbours (§4.4).

## 10. Open questions and assumptions (flagged, not decided here)

- **Q1 (owner):** option B on OpenShip included `WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED=true`, but the env-file lint
  refuses that name ("separate owner approval"). On DigitalOcean the lint runs, so subdomain origin trust stays off until
  a separate, reviewed PR allows it. Host routing itself is allowed.
- **Q2 (owner):** which off-host, append-only log shipper collects stdout (required by BC-07 for `CREWFLOW_AUDIT_SINK=stdout`)?
- **Q3 (owner):** an off-site, encrypted logical dump to R2 (plan §5.1) in addition to decision 53, before real payroll
  data? `RESTORE-DRILL.md` recommends it; decision 53 does not require it.
- **Q4 (owner):** high availability later now means Advanced Edition (from $130/month), not "+$30" (§2 finding 1).
- **A1:** PostgreSQL 16 (matches the evidence); 17 or 18 also work with the image.
- **A2:** port 80 open to Cloudflare as decision 25.4 says; closing it is allowed and stricter.
- **A3:** the front end's hosting (Cloudflare Pages / Workers) and its wildcard route are outside this runbook; only the
  DNS and TLS facts it depends on are here.
- **A4:** `AUTH_MFA_ENFORCE_PLATFORM_ADMIN=true` in the template implements decision 2 step 1 and is required by the
  first-admin bootstrap; the other MFA flags stay as they are until you set them.

## Sources (checked 2026-11-21)

- DigitalOcean: pricing pages for Droplets, Managed Databases, Spaces; docs "PostgreSQL Pricing" (updated 2026-09-30),
  "PostgreSQL Limits" (connections 22 / 47 / 97; PITR 7 days), "How to Connect to PostgreSQL" (verify-full on Standard
  and Advanced; CA download on Standard), "Regional Availability" (Managed PostgreSQL and Spaces in LON1).
- Cloudflare: "Universal SSL" (apex + first-level subdomains, free); https://www.cloudflare.com/ips-v4 and /ips-v6.
- This repository: `docker-compose.image.yml`, `docs/release/OPENSHIP-COMPATIBILITY.md`, `OWNER-LOGIN-DEPLOYMENT.md`,
  `MIGRATION-AND-ROLLBACK-PLAN.md`, `docs/hardening/LOAD-TEST.md` and `RESTORE-DRILL.md` (PR #313),
  `packages/rab-server/src/database/runtime/connection-budget.ts`, `docs/DECISIONS-PENDING.md` items 2, 14, 24-26, 49, 52, 53.
