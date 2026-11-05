#!/usr/bin/env python3
"""Crewflow image release gates (Docker hardening H5).

Every check inspects the EXACT image that was built (by image ID / manifest digest), never a Dockerfile or a lockfile, and
records one result file per check. Nothing here pushes, tags, deletes or prunes anything: the only Docker resources it
creates are scanner containers started with --rm and one stopped container per filesystem audit, which it removes by its
exact generated name.

  python3 image_gate.py [--mode pr|release] [--results DIR] <command> ...

  static                                   Dockerfile base-image pins, floors file, decision register, watch list
  config     <role> <image> --revision SHA --platform os/arch   runtime user, entrypoint, labels, env, architecture
  container  <role> <image>                security-floors.sh (Node/libexpat floors, Chromium absent, Alpine repositories)
                                           and module-paths-gate.cjs as every runtime identity, run inside the image
  fs         <role> <image>                exported filesystem: setuid/setgid, file capabilities, world-writable entries,
                                           code ownership, HOME, accounts, apk sources, test/env/.git files, dev packages,
                                           forbidden browser-stack apk/npm packages (P5), npm floors; writes the apk
                                           package list and size measurements
  scan       <role> <image> --image-id ID  Trivy (vuln, secret, CycloneDX, SARIF) + Grype, both pinned by digest; proves
                                           the scanned image ID and DB freshness
  vulns      <role>                        policy evaluation of the Trivy + Grype findings and the scanner-blind watch list
  secrets    <role>                        any secret Trivy finds in any layer or the image config fails
  attest     <role> <oci-layout> --image-id ID --revision SHA --platform os/arch   SBOM + provenance in the build output
  manifest   --expect-platforms a,b --revision SHA --out DIR role=platform=layout...   merged multi-platform index checks
  summary    --expected name,...           job summary; a missing result is a failure (never "skipped = passed")

Exit status: 1 if the check FAILED (in --mode pr, release-only findings are reported as HOLD and exit 0), 2 on usage.
The default mode is release (the strict one): forgetting --mode can never relax a gate.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
RAB = os.path.join(REPO, 'packages', 'rab-docker', 'rab')
FLOORS_ENV = os.path.join(RAB, 'security-floors.env')
FLOORS_SH = os.path.join(RAB, 'security-floors.sh')
MODULE_GATE = os.path.join(RAB, 'module-paths-gate.cjs')
POLICY_FILE = os.path.join(HERE, 'policy.json')
DECISIONS_FILE = os.path.join(HERE, 'vulnerability-decisions.json')
WATCHLIST_FILE = os.path.join(HERE, 'scanner-blind-advisories.json')

SEVERITY_RANK = {'UNKNOWN': 0, 'NEGLIGIBLE': 0, 'LOW': 1, 'MEDIUM': 2, 'HIGH': 3, 'CRITICAL': 4}
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
DIGEST_RE = re.compile(r'^sha256:[0-9a-f]{64}$')
MAX_DECISION_DAYS = 180


# ----------------------------------------------------------------------------------------------------------- results
class Check:
    """One gate result. fail() blocks in every mode; hold() blocks a release and is NEEDS OWNER APPROVAL on a PR."""

    def __init__(self, name: str, mode: str, results: str | None):
        self.name, self.mode, self.results = name, mode, results
        self.fails: list[str] = []
        self.holds: list[str] = []
        self.infos: list[str] = []
        self.data: dict = {}

    def fail(self, msg: str) -> None:
        self.fails.append(msg)

    def hold(self, msg: str) -> None:
        self.holds.append(msg)

    def info(self, msg: str) -> None:
        self.infos.append(msg)

    @property
    def status(self) -> str:
        if self.fails or (self.holds and self.mode == 'release'):
            return 'FAIL'
        return 'HOLD' if self.holds else 'PASS'

    def finish(self) -> int:
        status = self.status
        gha = os.environ.get('GITHUB_ACTIONS') == 'true'
        for m in self.fails:
            print(f'::error title={self.name}::{_gha_escape(m)}' if gha else f'[{self.name}] FAIL  {m}')
        for m in self.holds:
            kind = 'error' if self.mode == 'release' else 'warning'
            label = 'RELEASE-BLOCKING' if self.mode == 'release' else 'NEEDS OWNER APPROVAL (blocks a release)'
            print(f'::{kind} title={self.name}::{label}: {_gha_escape(m)}' if gha else f'[{self.name}] HOLD  {label}: {m}')
        for m in self.infos:
            print(f'[{self.name}] info  {m}')
        print(f'[{self.name}] {status} ({len(self.fails)} fail, {len(self.holds)} hold, mode={self.mode})')
        if self.results:
            os.makedirs(self.results, exist_ok=True)
            with open(os.path.join(self.results, f'{self.name}.json'), 'w', encoding='utf-8') as f:
                json.dump({'check': self.name, 'status': status, 'mode': self.mode, 'fails': self.fails,
                           'holds': self.holds, 'infos': self.infos, 'data': self.data}, f, indent=2, sort_keys=True)
        return 1 if status == 'FAIL' else 0


def _gha_escape(s: str) -> str:
    return s.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


# ----------------------------------------------------------------------------------------------------------- helpers
def load_json(path: str) -> dict:
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def policy() -> dict:
    return load_json(POLICY_FILE)


def role_policy(role: str) -> dict:
    roles = policy()['roles']
    if role not in roles:
        raise SystemExit(f'unknown role {role!r} (expected one of {sorted(roles)})')
    return roles[role]


def docker(*args: str, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess:
    p = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f'docker {" ".join(args[:3])}... exited {p.returncode}: {p.stderr.strip()[-600:]}')
    return p


def inspect_image(image: str) -> dict:
    out = json.loads(docker('image', 'inspect', image).stdout)
    if len(out) != 1:
        raise RuntimeError(f'image inspect {image}: expected one image, got {len(out)}')
    return out[0]


def read_floors() -> tuple[dict, list[str], list[str]]:
    """security-floors.env -> (single KEY=VALUE map, NPM_FLOOR values, problems)."""
    values: dict[str, str] = {}
    npm: list[str] = []
    problems: list[str] = []
    with open(FLOORS_ENV, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            m = re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$', line)
            if not m:
                problems.append(f'security-floors.env:{n}: not a KEY=VALUE line: {line!r}')
                continue
            key, val = m.groups()
            if key == 'NPM_FLOOR':
                npm.append(val)
            elif key in values:
                problems.append(f'security-floors.env:{n}: {key} defined more than once')
            else:
                values[key] = val
    return values, npm, problems


def numeric_version(v: str) -> tuple[int, ...]:
    """'156.0.8078.79' or '156.0.8078.79-r0' -> (156, 0, 8078, 79). Raises ValueError on anything else."""
    core = v.split('-r', 1)[0] if re.search(r'-r\d+$', v) else v
    if not re.fullmatch(r'\d+(\.\d+)+', core):
        raise ValueError(f'not a dotted numeric version: {v!r}')
    return tuple(int(x) for x in core.split('.'))


_SEMVER = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')


def semver_key(v: str) -> tuple:
    """Semantic Versioning 2.0 precedence key (a prerelease sorts before its release). Raises ValueError."""
    m = _SEMVER.match(v.strip())
    if not m:
        raise ValueError(f'not a semantic version: {v!r}')
    major, minor, patch, pre = int(m[1]), int(m[2]), int(m[3]), m[4]
    if pre is None:
        return (major, minor, patch, 1, ())
    ids = tuple((0, int(p), '') if p.isdigit() else (1, 0, p) for p in pre.split('.'))
    return (major, minor, patch, 0, ids)


def parse_npm_floor(spec: str) -> tuple[str, str]:
    m = re.fullmatch(r'((?:@[a-z0-9._~-]+/)?[a-z0-9._~-]+)@(\d+\.\d+\.\d+)', spec)
    if not m:
        raise ValueError(f'NPM_FLOOR must be <package>@<major.minor.patch>, got {spec!r}')
    return m[1], m[2]


def name_matches(name: str, patterns: list[str]) -> bool:
    """Exact name, or a prefix pattern ending in '*' ('@nx/*' = a whole scope, 'ffmpeg-*' = every ffmpeg library)."""
    return any(name == p or (p.endswith('*') and name.startswith(p[:-1])) for p in patterns)


def today(mode: str = 'release') -> dt.date:
    """Real UTC date. IMAGE_GATE_TODAY pins it for self-tests only: it is refused in release mode and in GitHub Actions
    (review F4), so it can never move a decision's expiry in a real gate run."""
    override = os.environ.get('IMAGE_GATE_TODAY')
    if override:
        if mode == 'release' or os.environ.get('GITHUB_ACTIONS') == 'true':
            raise RuntimeError('IMAGE_GATE_TODAY is a self-test override and is refused in release mode and in CI')
        return dt.date.fromisoformat(override)
    return dt.datetime.now(dt.timezone.utc).date()


# ----------------------------------------------------------------------------------------------------------- static
def validate_decisions(c: Check) -> list[dict]:
    """Owner risk decisions: every entry complete, one advisory + one package, not expired, at most 180 days long."""
    reg = load_json(DECISIONS_FILE)
    if reg.get('schema') != 1 or not isinstance(reg.get('decisions'), list):
        c.fail('vulnerability-decisions.json: schema must be 1 and decisions a list')
        return []
    valid = []
    required = ['id', 'packages', 'images', 'decision', 'owner_decision_ref', 'decided_by', 'decided_on', 'expires',
                'justification']
    seen = set()
    for i, d in enumerate(reg['decisions']):
        where = f'vulnerability-decisions.json decisions[{i}]'
        missing = [k for k in required if not d.get(k)]
        if missing:
            c.fail(f'{where}: missing {", ".join(missing)}')
            continue
        if not re.fullmatch(r'(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})', d['id']):
            c.fail(f'{where}: id {d["id"]!r} must name exactly one CVE or GHSA advisory (no wildcards)')
            continue
        if not isinstance(d['packages'], list) or not all(
                isinstance(p, str) and p and not any(ch in p for ch in '*?[]') for p in d['packages']):
            c.fail(f'{where}: packages must be a list of exact package names (no wildcards)')
            continue
        if d['decision'] not in ('accepted-risk', 'not-affected', 'false-positive'):
            c.fail(f'{where}: decision must be accepted-risk, not-affected or false-positive')
            continue
        if not isinstance(d['images'], list) or not set(d['images']) <= set(policy()['roles']) or not d['images']:
            c.fail(f'{where}: images must be a non-empty subset of {sorted(policy()["roles"])} (O1: one image)')
            continue
        try:
            decided, expires = dt.date.fromisoformat(d['decided_on']), dt.date.fromisoformat(d['expires'])
        except ValueError:
            c.fail(f'{where}: decided_on / expires must be YYYY-MM-DD')
            continue
        if expires < today(c.mode):
            c.fail(f'{where}: decision {d["owner_decision_ref"]} for {d["id"]} ({", ".join(d["packages"])}) EXPIRED on {expires}; '
                   're-review it (the finding is treated as undecided)')
            continue
        if decided > today(c.mode):
            c.fail(f'{where}: decided_on {decided} is in the future (the {MAX_DECISION_DAYS}-day limit counts from the '
                   'actual decision)')
            continue
        if (expires - decided).days > MAX_DECISION_DAYS or expires < decided:
            c.fail(f'{where}: expires must be within {MAX_DECISION_DAYS} days after decided_on')
            continue
        keys = {(d['id'], p) for p in d['packages']}
        if keys & seen:
            c.fail(f'{where}: duplicate decision for {sorted(keys & seen)}')
            continue
        seen |= keys
        valid.append(d)
    c.info(f'{len(valid)} valid owner risk decision(s) in the register')
    return valid


def validate_watchlist(c: Check) -> list[dict]:
    wl = load_json(WATCHLIST_FILE)
    out = []
    if wl.get('schema') != 1 or not isinstance(wl.get('advisories'), list):
        c.fail('scanner-blind-advisories.json: schema must be 1 and advisories a list')
        return out
    for i, a in enumerate(wl['advisories']):
        if not (a.get('id') and a.get('packages') and a.get('affected_versions') and
                str(a.get('severity', '')).upper() in ('HIGH', 'CRITICAL')):
            c.fail(f'scanner-blind-advisories.json advisories[{i}]: id, packages, affected_versions and a High/Critical '
                   'severity are required')
            continue
        out.append(a)
    return out


def dockerfile_instructions(path: str) -> list[tuple[int, str]]:
    """Docker's own line handling: comments dropped (also inside continuations), backslash continuations joined."""
    out, buf, start = [], '', 0
    with open(path, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip('\n')
            if re.match(r'^\s*#', line):
                continue
            if not buf:
                start = n
            if re.search(r'\\\s*$', line):
                buf += re.sub(r'\\\s*$', ' ', line)
                continue
            buf += line
            if buf.strip():
                out.append((start, buf.strip()))
            buf = ''
    if buf.strip():
        out.append((start, buf.strip()))
    return out


def check_dockerfile_pins(c: Check, files: list[str]) -> None:
    allowed_args = policy()['dockerfiles']['arg_base_images']
    for rel in files:
        path = os.path.join(REPO, rel)
        with open(path, encoding='utf-8') as f:
            first = f.readline()
        m = re.match(r'^#\s*syntax\s*=\s*(\S+)', first, re.I)
        if m and not re.search(r'@sha256:[0-9a-f]{64}$', m[1]):
            c.hold(f'{rel}:1: the BuildKit frontend `# syntax={m[1]}` is pulled from Docker Hub by a mutable tag at every '
                   'build; pin it by digest (Dockerfile owner change, see the H5 report)')
        stages: set[str] = set()
        for n, ins in dockerfile_instructions(path):
            word = ins.split(None, 1)[0].upper()
            if word == 'FROM':
                toks = [t for t in ins.split()[1:] if not t.startswith('--')]
                ref = toks[0] if toks else ''
                alias = toks[2].lower() if len(toks) >= 3 and toks[1].upper() == 'AS' else None
                if ref.lower() in stages or ref == 'scratch':
                    pass
                elif re.fullmatch(r'[a-z0-9./_:-]+@sha256:[0-9a-f]{64}', ref):
                    pass
                elif '$' in ref:
                    allowed = allowed_args.get(rel)
                    if not allowed or allowed.get('ref') != ref:
                        c.fail(f'{rel}:{n}: FROM {ref} is an unpinned build-argument base image with no policy entry')
                    else:
                        c.info(f'{rel}:{n}: FROM {ref} allowed by policy ({allowed["reason"]})')
                else:
                    c.fail(f'{rel}:{n}: FROM {ref} is not pinned by digest (image@sha256:<64 hex>)')
                if alias:
                    stages.add(alias)
            elif word in ('COPY', 'ADD', 'RUN'):
                for fm in re.finditer(r'--(?:from|mount=[^ ]*from)=([^\s,]+)', ins):
                    ref = fm[1]
                    if ref.lower() in stages or ref.isdigit():
                        continue
                    if not re.fullmatch(r'[a-z0-9./_:-]+@sha256:[0-9a-f]{64}', ref):
                        c.fail(f'{rel}:{n}: {word} --from={ref} is neither an earlier stage nor pinned by digest')
            if word == 'ADD' and re.search(r'\shttps?://', ins):
                c.fail(f'{rel}:{n}: ADD <url> fetches unpinned remote content at build time')
        c.info(f'{rel}: {len(stages)} stage(s); every external base image pinned by digest')


def cmd_static(a, c: Check) -> None:
    files = subprocess.run(['git', '-C', REPO, 'ls-files', 'packages/rab-docker/*Dockerfile*'], capture_output=True,
                           text=True, check=True).stdout.split()
    if not files:
        c.fail('no tracked Dockerfile under packages/rab-docker')
    check_dockerfile_pins(c, files)
    for role, rp in policy()['roles'].items():
        if rp['dockerfile'] not in files:
            c.fail(f'policy role {role}: {rp["dockerfile"]} is not a tracked Dockerfile')
        for key in ('forbidden_apk', 'forbidden_npm', 'sbom_must_not_include'):
            if not isinstance(rp.get(key), list) or not rp[key]:
                c.fail(f'policy role {role}: {key} must be a non-empty list (P5: Chromium must never return)')
        if 'apk-absent:chromium' not in rp.get('floors_checks', []):
            c.fail(f'policy role {role}: floors_checks must include apk-absent:chromium (P5)')
        if 'chromium_binary' in rp:
            c.fail(f'policy role {role}: chromium_binary is retired (P5: no image ships Chromium)')
    values, npm, problems = read_floors()
    for p in problems:
        c.fail(p)
    for key in ('MIN_NODE_VERSION', 'MIN_LIBEXPAT_VERSION', 'ALPINE_BRANCH'):
        if not values.get(key):
            c.fail(f'security-floors.env: {key} missing or empty')
    # P5: no image installs Chromium any more (both roles run apk-absent:chromium), so a Chromium floor would be dead
    # configuration that suggests a browser is expected. Refuse it rather than silently carry it.
    if 'MIN_CHROMIUM_VERSION' in values:
        c.fail('security-floors.env: MIN_CHROMIUM_VERSION is retired (P5: no image installs Chromium); delete it')
    try:
        if len(numeric_version(values.get('MIN_NODE_VERSION', ''))) != 3:
            raise ValueError
    except ValueError:
        c.fail(f'security-floors.env: MIN_NODE_VERSION {values.get("MIN_NODE_VERSION")!r} is not X.Y.Z')
    if not re.fullmatch(r'v\d+\.\d+', values.get('ALPINE_BRANCH', '')):
        c.fail('security-floors.env: ALPINE_BRANCH must be vMAJOR.MINOR')
    for spec in npm:
        try:
            parse_npm_floor(spec)
        except ValueError as e:
            c.fail(f'security-floors.env: {e}')
    c.data['floors'] = values
    c.data['npm_floors'] = npm
    c.info(f'floors: node>={values.get("MIN_NODE_VERSION")} '
           f'libexpat>={values.get("MIN_LIBEXPAT_VERSION")} alpine={values.get("ALPINE_BRANCH")} npm={npm or "none"}')
    validate_decisions(c)
    wl = validate_watchlist(c)
    c.info(f'{len(wl)} scanner-blind advisory watch-list entr{"y" if len(wl) == 1 else "ies"}')
    pol = policy()
    for tool in ('trivy', 'grype'):
        img = pol['scanners'][tool]['image']
        if not re.fullmatch(r'[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}', img):
            c.fail(f'policy.json scanners.{tool}.image must be pinned by digest: {img}')


# ----------------------------------------------------------------------------------------------------------- config
def cmd_config(a, c: Check) -> None:
    rp = role_policy(a.role)
    img = inspect_image(a.image)
    cfg = img.get('Config') or {}
    c.data.update(image_id=img['Id'], repo_digests=img.get('RepoDigests'), os=img.get('Os'),
                  architecture=img.get('Architecture'), variant=img.get('Variant'))
    want_os, want_arch = a.platform.split('/')[:2]
    if img.get('Os') != want_os or img.get('Architecture') != want_arch:
        c.fail(f'image platform is {img.get("Os")}/{img.get("Architecture")}, expected {a.platform}')
    if (cfg.get('User') or '') != rp['user']:
        c.fail(f'runtime user is {cfg.get("User")!r}, expected {rp["user"]!r}')
    if (cfg.get('Entrypoint') or []) != rp['entrypoint']:
        c.fail(f'entrypoint is {cfg.get("Entrypoint")}, expected {rp["entrypoint"]}')
    if (cfg.get('Cmd') or []) != rp['cmd']:
        c.fail(f'cmd is {cfg.get("Cmd")}, expected {rp["cmd"]}')
    ports = sorted((cfg.get('ExposedPorts') or {}).keys())
    if ports != sorted(rp['exposed_ports']):
        c.fail(f'exposed ports {ports}, expected {rp["exposed_ports"]}')
    if rp['healthcheck_required'] and not (cfg.get('Healthcheck') or {}).get('Test'):
        c.fail('no HEALTHCHECK in the image config')
    labels = cfg.get('Labels') or {}
    rev = labels.get('org.opencontainers.image.revision')
    if not SHA_RE.fullmatch(a.revision or ''):
        c.fail(f'--revision {a.revision!r} is not a full 40-hex commit id')
    elif rev != a.revision:
        c.fail(f'label org.opencontainers.image.revision={rev!r} does not equal the source commit {a.revision}')
    else:
        c.info(f'org.opencontainers.image.revision = {rev}')
    if a.source and labels.get('org.opencontainers.image.source') != a.source:
        c.fail(f'label org.opencontainers.image.source={labels.get("org.opencontainers.image.source")!r}, '
               f'expected {a.source}')
    pat = re.compile(policy()['secret_env_name_pattern'], re.I)
    for e in cfg.get('Env') or []:
        k, _, v = e.partition('=')
        if pat.search(k):
            c.fail(f'image config sets environment variable {k} (secret-like name); credentials are runtime-only')
        if re.search(r'://[^/\s:@]+:[^/\s@]+@', v):
            c.fail(f'image config environment variable {k} carries a URL with embedded credentials')
    c.info(f'user={cfg.get("User")!r} entrypoint={cfg.get("Entrypoint")} cmd={cfg.get("Cmd")} id={img["Id"]}')


# ----------------------------------------------------------------------------------------------------------- container
def _mount(src: str, dst: str) -> list[str]:
    return ['--mount', f'type=bind,source={src},target={dst},readonly']


def cmd_container(a, c: Check) -> None:
    rp = role_policy(a.role)
    base = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--pull', 'never']
    # 1. The H1 security floors, re-run against the finished image (a cached or stale layer cannot skip them).
    p = docker(*base, '--read-only', '--user', '0:0', '--entrypoint', '/bin/sh',
               *_mount(FLOORS_SH, '/gate/security-floors.sh'), *_mount(FLOORS_ENV, '/gate/security-floors.env'),
               a.image, '/gate/security-floors.sh', '/gate/security-floors.env', *rp['floors_checks'],
               check=False, timeout=300)
    out = (p.stdout + p.stderr).strip()
    c.data['floors_output'] = out.splitlines()
    if p.returncode != 0:
        c.fail(f'security-floors.sh {" ".join(rp["floors_checks"])} failed (exit {p.returncode}): '
               + ' | '.join(l for l in out.splitlines() if 'FATAL' in l or 'security-floor' in l)[-800:])
    elif out.count('security-floor: OK') < len(rp['floors_checks']):
        c.fail(f'security-floors.sh exited 0 but reported fewer OK lines than checks: {out[-500:]}')
    else:
        for line in out.splitlines():
            c.info(line)
    # 2. The H1-M1 module-path gate as every runtime identity (not read-only: it must see real writability).
    for ident in rp['module_path_identities']:
        env = ['-e', f'HOME={ident["home"]}'] if ident['home'] else []
        p = docker(*base, '--user', ident['user'], *env, '--entrypoint', 'node',
                   *_mount(MODULE_GATE, '/gate/module-paths-gate.cjs'), a.image, '/gate/module-paths-gate.cjs',
                   check=False, timeout=120)
        out = (p.stdout + p.stderr).strip()
        if p.returncode != 0 or 'module-paths-gate: OK' not in out:
            c.fail(f'module-paths-gate as {ident["user"]} failed (exit {p.returncode}): {out[-600:]}')
        else:
            c.info(out.splitlines()[-1])


# ----------------------------------------------------------------------------------------------------------- fs
def _under(path: str, roots) -> bool:
    return any(path == r or path.startswith(r.rstrip('/') + '/') for r in roots)


def cmd_fs(a, c: Check) -> None:
    rp = role_policy(a.role)
    pol = policy()
    fsp, pk = pol['filesystem'], pol['packages']
    floors, npm_specs, _ = read_floors()
    npm_floors = {}
    for spec in npm_specs:
        try:
            name, ver = parse_npm_floor(spec)
            npm_floors[name] = ver
        except ValueError as e:
            c.fail(str(e))
    writable = rp['writable_dirs']
    test_re = re.compile(fsp['test_file_pattern'])
    h3 = pk['h3_target'] + pk['h3_target_by_role'].get(a.role, [])
    # every installed npm package anywhere in the image (/app, /usr/local/lib/node_modules, /opt/crewflow-bundle, ...)
    pkg_re = re.compile(r'^(?:/.*)?/node_modules/((?:@[^/]+/)?[^/@][^/]*)/package\.json$')
    stats = {'files': 0, 'bytes': 0, 'node_modules_bytes': 0}
    seen_paths: dict[str, tarfile.TarInfo] = {}
    capture = {'/etc/passwd', '/etc/apk/repositories', '/etc/apk/world', '/etc/alpine-release', '/lib/apk/db/installed'}
    captured: dict[str, str] = {}
    packages: dict[str, set] = {}
    issues: dict[str, list[str]] = {}

    def add(kind: str, msg: str) -> None:
        issues.setdefault(kind, []).append(msg)

    name = f'crewflow-h5-fs-{uuid.uuid4().hex[:12]}'
    docker('create', '--name', name, '--network', 'none', '--pull', 'never', a.image, timeout=120)
    try:
        proc = subprocess.Popen(['docker', 'export', name], stdout=subprocess.PIPE)
        with tarfile.open(fileobj=proc.stdout, mode='r|') as tar:
            for m in tar:
                rel = m.name[2:] if m.name.startswith('./') else m.name
                path = '/' + rel.lstrip('/').rstrip('/')
                if path == '/':
                    continue
                if _under(path, [p.rstrip('/') for p in fsp['ignore_prefixes']]):
                    continue
                seen_paths[path] = m
                if m.isfile() or m.islnk():
                    stats['files'] += 1
                    stats['bytes'] += m.size
                    if '/node_modules/' in path:
                        stats['node_modules_bytes'] += m.size
                if m.isfile() and (path in capture or pkg_re.match(path)):
                    data = tar.extractfile(m).read()
                    if path in capture:
                        captured[path] = data.decode('utf-8', 'replace')
                    else:
                        pm = pkg_re.match(path)
                        try:
                            ver = str(json.loads(data).get('version', '?'))
                        except (ValueError, AttributeError):
                            ver = '?'
                        packages.setdefault(pm[1], set()).add((ver, path))
                if m.issym():
                    continue
                mode = m.mode
                # privileged files
                if (m.isfile() or m.islnk()) and mode & 0o6000:
                    add('setuid/setgid file', f'{path} mode {oct(mode)} owner {m.uid}:{m.gid}')
                if any(k.startswith('SCHILY.xattr.security.capability') for k in m.pax_headers):
                    add('file capability', f'{path} carries security.capability (file capabilities)')
                if m.isdir() and mode & 0o2000:
                    c.info(f'setgid directory (not a privilege): {path} {oct(mode)}')
                # world-writable anywhere
                if mode & 0o002 and not m.isdev():
                    if not (m.isdir() and mode & 0o1000 and path in fsp['sticky_world_writable_dirs']):
                        add('world-writable', f'{path} mode {oct(mode)}')
                # code-loading paths: root-owned and not group/other-writable, except the runtime data dirs
                if _under(path, fsp['code_paths']) and not _under(path, writable.keys()):
                    if m.uid != 0 or m.gid != 0 or mode & 0o022:
                        add('code path not root-owned/read-only', f'{path} {m.uid}:{m.gid} {oct(mode)}')
                # test files / env files / VCS metadata in application code
                if _under(path, fsp['test_scan_roots']) and '/node_modules/' not in path:
                    parts = path.split('/')
                    if any(p in fsp['test_dir_names'] for p in parts) or test_re.search(path):
                        add('test file', path)
                if path.startswith('/app/') and '/node_modules/' not in path:
                    base = path.rsplit('/', 1)[-1]
                    if (base.startswith('.env') or base.endswith('.env')) and base != '.env.example':
                        add('env file', path)
                    if '.git' in path.split('/'):
                        add('git metadata', path)
        rc = proc.wait()
        if rc != 0:
            c.fail(f'docker export exited {rc}: the filesystem audit is incomplete')
    finally:
        docker('rm', name, check=False)  # exact name of the stopped container this command created
    if stats['files'] < 1000:
        c.fail(f'exported filesystem has only {stats["files"]} files: the audit did not see the image')

    blocking = ['setuid/setgid file', 'file capability', 'world-writable', 'code path not root-owned/read-only',
                'test file', 'env file', 'git metadata']
    for kind in blocking:
        items = issues.get(kind, [])
        if items:
            c.fail(f'{len(items)} {kind} entr{"y" if len(items) == 1 else "ies"}: ' + '; '.join(items[:15])
                   + (' ...' if len(items) > 15 else ''))
        else:
            c.info(f'no {kind} entries')

    # runtime data dirs, HOME, required files
    for d, uid in writable.items():
        m = seen_paths.get(d)
        if m is None or not m.isdir():
            c.fail(f'runtime data directory {d} is missing')
        elif m.uid != uid or m.mode & 0o022:
            c.fail(f'runtime data directory {d} is {m.uid}:{m.gid} {oct(m.mode)}; expected owner {uid}, '
                   'no group/other write')
    for d in rp['home_dirs_root_owned']:
        m = seen_paths.get(d)
        if m is not None and (m.uid != 0 or m.mode & 0o222):
            c.fail(f'HOME {d} is {m.uid}:{m.gid} {oct(m.mode)}; it must be root-owned and not writable (H1-M1)')
    for f in rp['required_files']:
        if f not in seen_paths:
            c.fail(f'required file {f} is missing')

    # accounts
    passwd = captured.get('/etc/passwd', '')
    accts = {}
    for line in passwd.splitlines():
        parts = line.split(':')
        if len(parts) >= 7:
            accts[parts[0]] = int(parts[2]) if parts[2].isdigit() else -1
    root_like = sorted(n for n, u in accts.items() if u == 0)
    if root_like != ['root']:
        c.fail(f'uid 0 accounts: {root_like} (only root may have uid 0)')
    for n, uid in rp['accounts'].items():
        if accts.get(n) != uid:
            c.fail(f'account {n} has uid {accts.get(n)}, expected {uid}')

    # apk sources (independent of security-floors.sh, which also checks them inside the image)
    branch = floors.get('ALPINE_BRANCH', '')
    repo_re = re.compile(r'^https://dl-cdn\.alpinelinux\.org/alpine/' + re.escape(branch) + r'/(main|community)/?$')
    repos = [l.strip() for l in captured.get('/etc/apk/repositories', '').splitlines()
             if l.strip() and not l.strip().startswith('#')]
    if not repos:
        c.fail('/etc/apk/repositories is missing or empty')
    for r in repos:
        if not repo_re.match(r):
            c.fail(f'unapproved apk repository: {r!r} (only dl-cdn.alpinelinux.org/alpine/{branch}/main|community)')
    for p in seen_paths:
        if _under(p, ['/etc/apk/repositories.d', '/lib/apk/repositories.d']) and not seen_paths[p].isdir():
            c.fail(f'apk repository drop-in present: {p}')
        if p in ('/etc/apk/config', '/lib/apk/config'):
            c.fail(f'apk configuration file present: {p}')
    if '@' in captured.get('/etc/apk/world', ''):
        c.fail('/etc/apk/world pins a package to a tagged repository')
    rel = captured.get('/etc/alpine-release', '').strip()
    if not rel or 'v' + '.'.join(rel.split('.')[:2]) != branch:
        c.fail(f'/etc/alpine-release is {rel!r}, expected {branch}')
    c.info(f'apk repositories: {repos}; alpine {rel}')

    # npm packages: blocked, H3 target, floors
    dev_found = []
    for n, copies in sorted(packages.items()):
        where = ', '.join(sorted(p for _, p in copies))[:300]
        if name_matches(n, pk['block']):
            c.fail(f'build-only package {n} is in the runtime image ({where})')
        elif name_matches(n, h3):
            dev_found.append(n if len(copies) == 1 else f'{n} x{len(copies)}')
        if n in npm_floors:
            for ver, p in copies:
                try:
                    if semver_key(ver) < semver_key(npm_floors[n]):
                        c.fail(f'{n} {ver} at {p} is below NPM_FLOOR {npm_floors[n]}')
                except ValueError:
                    c.fail(f'{n} at {p}: cannot compare version {ver!r} with NPM_FLOOR {npm_floors[n]}')
    for n in npm_floors:
        if n not in packages:
            c.info(f'NPM_FLOOR {n}: not installed')
    if dev_found:
        c.hold(f'{len(dev_found)} development-only packages are in the runtime image (H3 production-only node_modules '
               f'must remove them): {", ".join(dev_found)}')
    # P5: the browser driver must never return (fails in every mode, not a HOLD).
    bad_npm = sorted(f'{n} ({", ".join(sorted(p for _, p in packages[n]))[:200]})' for n in packages
                     if name_matches(n, rp['forbidden_npm']))
    if bad_npm:
        c.fail(f'forbidden browser package(s) in the runtime image (P5: native PDF rendering only): {"; ".join(bad_npm)}')
    else:
        c.info(f'no forbidden browser npm package ({", ".join(rp["forbidden_npm"])})')
    c.data['dev_packages'] = dev_found

    apk = {}
    cur = {}
    for line in captured.get('/lib/apk/db/installed', '').splitlines() + ['']:
        if not line.strip():
            if cur.get('P'):
                apk[cur['P']] = cur.get('V', '')
            cur = {}
        elif len(line) > 2 and line[1] == ':':
            cur.setdefault(line[0], line[2:])
    if not apk:
        c.fail('/lib/apk/db/installed is missing or empty: cannot list OS packages')
    # P5: Chromium and every OS package that only Chromium pulled in (ffmpeg, libsndfile, alsa-lib, glib, libxml2, ...)
    # must never return to a runtime image: FAIL in every mode, never a HOLD.
    bad_apk = sorted(f'{n} {v}' for n, v in apk.items() if name_matches(n, rp['forbidden_apk']))
    if bad_apk:
        c.fail(f'forbidden browser-stack OS package(s) in the runtime image (P5): {", ".join(bad_apk)}')
    elif apk:
        c.info(f'no forbidden browser-stack OS package ({len(rp["forbidden_apk"])} names/prefixes checked)')
    for path in ('/usr/lib/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'):
        if path in seen_paths:
            c.fail(f'{path} exists in the runtime image (P5: no browser)')
    c.data.update(apk=apk, npm_package_dirs=sum(len(v) for v in packages.values()),
                  npm_package_names=len(packages), stats=stats)
    c.info(f'{stats["files"]} files, {stats["bytes"] / 1e6:.1f} MB uncompressed, node_modules '
           f'{stats["node_modules_bytes"] / 1e6:.1f} MB, {len(packages)} npm package names '
           f'({sum(len(v) for v in packages.values())} copies), {len(apk)} apk packages')
    if a.results:
        with open(os.path.join(a.results, f'{a.role}-apk.json'), 'w', encoding='utf-8') as f:
            json.dump(apk, f, indent=1, sort_keys=True)


# ----------------------------------------------------------------------------------------------------------- scan
def cmd_scan(a, c: Check) -> None:
    pol = policy()['scanners']
    out = os.path.abspath(a.results)
    os.makedirs(out, exist_ok=True)
    sock = ['-v', '/var/run/docker.sock:/var/run/docker.sock']
    outm = ['--mount', f'type=bind,source={out},target=/out']
    trivy = ['run', '--rm', *sock, *outm, '-v', f'{a.trivy_cache}:/root/.cache', '--pull', 'missing',
             pol['trivy']['image']]
    # The DB is updated explicitly below (with retries); the scan itself never downloads, so a failed download can
    # never silently fall back to a stale or missing DB.
    grype = ['run', '--rm', *sock, *outm, '-v', f'{a.grype_cache}:/cache', '-e', 'GRYPE_DB_CACHE_DIR=/cache',
             '-e', 'GRYPE_DB_AUTO_UPDATE=false', '-e', 'GRYPE_CHECK_FOR_APP_UPDATE=false', '--pull', 'missing',
             pol['grype']['image']]
    r = a.role
    # Pull the digest-pinned scanner images first, so their pull progress never hides a scanner's own error message.
    for img in (pol['trivy']['image'], pol['grype']['image']):
        p = docker('pull', '--quiet', img, check=False, timeout=600)
        if p.returncode != 0:
            c.fail(f'cannot pull pinned scanner image {img}: {p.stderr.strip()[-300:]}')
    # Grype DB: a transient CDN error must not need a manual re-run, but a DB that never arrives fails the check.
    for attempt in range(1, 4):
        p = docker(*grype, 'db', 'update', check=False, timeout=900)
        if p.returncode == 0:
            break
        c.info(f'grype db update attempt {attempt} failed: {(p.stderr or p.stdout).strip()[-300:]}')
        if attempt < 3:
            time.sleep(20 * attempt)
    else:
        c.fail('grype DB could not be downloaded after 3 attempts (no scan without a current DB)')
    steps = [
        ('trivy vuln', trivy + ['image', '--quiet', '--scanners', 'vuln', '--list-all-pkgs', '--format', 'json',
                                '--output', f'/out/{r}-trivy-vuln.json', a.image]),
        ('trivy secret', trivy + ['image', '--quiet', '--skip-db-update', '--scanners', 'secret',
                                  '--image-config-scanners', 'secret', '--format', 'json',
                                  '--output', f'/out/{r}-trivy-secret.json', a.image]),
        ('trivy sarif', trivy + ['convert', '--quiet', '--format', 'sarif', '--output', f'/out/{r}-trivy.sarif',
                                 f'/out/{r}-trivy-vuln.json']),
        ('trivy cyclonedx', trivy + ['convert', '--quiet', '--format', 'cyclonedx',
                                     '--output', f'/out/{r}-sbom.cdx.json', f'/out/{r}-trivy-vuln.json']),
        ('grype', grype + [f'docker:{a.image}', '-o', 'json', '--file', f'/out/{r}-grype.json']),
    ]
    for label, args in steps:
        p = docker(*args, check=False, timeout=3600)
        if p.returncode != 0:
            c.fail(f'{label} exited {p.returncode}: {(p.stderr or p.stdout).strip()[-500:]}')
    meta = {}
    p = docker(*trivy, 'version', '--format', 'json', check=False)
    try:
        meta['trivy'] = json.loads(p.stdout)
    except ValueError:
        c.fail(f'trivy version unreadable: {p.stdout[-200:]} {p.stderr[-200:]}')
    p = docker(*grype, 'version', '-o', 'json', check=False)
    try:
        meta['grype'] = json.loads(p.stdout)
    except ValueError:
        c.fail(f'grype version unreadable: {p.stderr[-200:]}')
    p = docker(*grype, 'db', 'status', '-o', 'json', check=False)
    try:
        meta['grype_db'] = json.loads(p.stdout)
    except ValueError:
        c.fail(f'grype db status unreadable: {p.stderr[-200:]}')
    with open(os.path.join(out, f'{r}-scanner-versions.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)
    now = dt.datetime.now(dt.timezone.utc)
    max_age = dt.timedelta(hours=pol['max_db_age_hours'])

    def ts(s):
        t = dt.datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', str(s).strip()).replace('Z', '+00:00'))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)

    tv = (meta.get('trivy') or {})
    if tv.get('Version') != pol['trivy']['version']:
        c.fail(f'trivy version {tv.get("Version")!r} != pinned {pol["trivy"]["version"]}')
    try:
        t_db = ts(tv['VulnerabilityDB']['UpdatedAt'])
        c.info(f'trivy {tv.get("Version")} DB UpdatedAt {t_db.isoformat()}')
        if now - t_db > max_age:
            c.fail(f'trivy DB is older than {pol["max_db_age_hours"]} h ({t_db.isoformat()})')
    except (KeyError, TypeError, ValueError):
        c.fail('trivy DB timestamp missing')
    gv = (meta.get('grype') or {}).get('version', '')
    if gv.lstrip('v') != pol['grype']['version']:
        c.fail(f'grype version {gv!r} != pinned {pol["grype"]["version"]}')
    try:
        g_db = ts(meta['grype_db']['built'])
        c.info(f'grype {gv} DB built {g_db.isoformat()} schema {meta["grype_db"].get("schemaVersion")}')
        if now - g_db > max_age:
            c.fail(f'grype DB is older than {pol["max_db_age_hours"]} h ({g_db.isoformat()})')
        if not meta['grype_db'].get('valid', False):
            c.fail('grype DB reports valid=false')
    except (KeyError, TypeError, ValueError):
        c.fail('grype DB timestamp missing')
    # The scanners must have looked at exactly the gated image: the same image ID (Trivy reports Docker's ID) and the
    # same layer chain (diff IDs = the uncompressed content of every layer, in order). Grype reports the config digest,
    # which equals Docker's ID only with the classic image store, so its identity is proven by the layer chain.
    img = inspect_image(a.image)
    if img['Id'] != a.image_id:
        c.fail(f'{a.image} is now {img["Id"]}, not the gated {a.image_id}')
    layers = img['RootFS']['Layers']
    try:
        for kind in ('vuln', 'secret'):
            md = load_json(os.path.join(out, f'{r}-trivy-{kind}.json'))['Metadata']
            if md.get('ImageID') != a.image_id:
                c.fail(f'Trivy {kind} scan saw image {md.get("ImageID")}, expected {a.image_id}')
            if md.get('DiffIDs') != layers:
                c.fail(f'Trivy {kind} scan saw a different layer chain than {a.image_id}')
    except (OSError, KeyError, ValueError) as e:
        c.fail(f'Trivy output unreadable: {e}')
    try:
        tgt = load_json(os.path.join(out, f'{r}-grype.json'))['source']['target']
        if [l.get('digest') for l in tgt.get('layers') or []] != layers:
            c.fail(f'Grype scanned a different layer chain than {a.image_id}')
        c.info(f'Grype target: config {tgt.get("imageID")}, manifest {tgt.get("manifestDigest")}, '
               f'{len(layers)} layers identical to the gated image')
    except (OSError, KeyError, ValueError) as e:
        c.fail(f'Grype output unreadable: {e}')
    c.data['scanners'] = {'trivy': tv.get('Version'), 'grype': gv,
                          'trivy_db': (tv.get('VulnerabilityDB') or {}).get('UpdatedAt'),
                          'grype_db': (meta.get('grype_db') or {}).get('built')}


# ----------------------------------------------------------------------------------------------------------- vulns
def _sev(s: str) -> str:
    s = (s or 'UNKNOWN').upper()
    return s if s in SEVERITY_RANK else 'UNKNOWN'


def collect_findings(trivy: dict, grype: dict) -> dict:
    """(advisory, package, installed version) -> merged finding from both scanners."""
    found: dict[tuple, dict] = {}

    def put(aid, aliases, pkg, ver, sev, fixed, fix_versions, scanner, ptype):
        cves = sorted({x for x in [aid, *aliases] if x and x.startswith('CVE-')})
        key_id = cves[0] if cves else aid
        k = (key_id, pkg, ver)
        f = found.setdefault(k, {'id': key_id, 'aliases': set(), 'package': pkg, 'installed': ver, 'type': ptype,
                                 'severity': 'UNKNOWN', 'fixable': False, 'fixed_in': set(), 'scanners': set()})
        f['aliases'].update(x for x in [aid, *aliases] if x and x != key_id)
        if SEVERITY_RANK[_sev(sev)] > SEVERITY_RANK[f['severity']]:
            f['severity'] = _sev(sev)
        if fixed:
            f['fixable'] = True
            f['fixed_in'].update(v for v in fix_versions if v)
        f['scanners'].add(scanner)

    for res in trivy.get('Results') or []:
        for v in res.get('Vulnerabilities') or []:
            fv = (v.get('FixedVersion') or '').strip()
            fixed = bool(fv) or v.get('Status') == 'fixed'
            put(v['VulnerabilityID'], v.get('VendorIDs') or [], v['PkgName'], v.get('InstalledVersion', ''),
                v.get('Severity'), fixed, [x.strip() for x in fv.split(',')], 'trivy', res.get('Type', ''))
    for m in grype.get('matches') or []:
        v, art = m['vulnerability'], m['artifact']
        fix = v.get('fix') or {}
        fixed = fix.get('state') == 'fixed' and bool(fix.get('versions'))
        aliases = [r.get('id') for r in m.get('relatedVulnerabilities') or []]
        put(v['id'], aliases, art['name'], art.get('version', ''), v.get('severity'), fixed, fix.get('versions') or [],
            'grype', art.get('type', ''))
    return found


def cmd_vulns(a, c: Check) -> None:
    res = a.results
    trivy = load_json(os.path.join(res, f'{a.role}-trivy-vuln.json'))
    grype = load_json(os.path.join(res, f'{a.role}-grype.json'))
    apk = load_json(os.path.join(res, f'{a.role}-apk.json'))
    decisions = [d for d in validate_decisions(c) if a.role in d['images']]
    watch = validate_watchlist(c)
    found = collect_findings(trivy, grype)
    # scanner-blind watch list: adds findings the scanners miss; never removes or downgrades one
    for w in watch:
        for pkg in w['packages']:
            if pkg not in apk:
                continue
            ver = apk[pkg]
            if ver in w['affected_versions']:
                k = (w['id'], pkg, ver)
                f = found.setdefault(k, {'id': w['id'], 'aliases': set(), 'package': pkg, 'installed': ver,
                                         'type': 'apk', 'severity': _sev(w['severity']), 'fixable': False,
                                         'fixed_in': set(), 'scanners': set()})
                f['scanners'].add('watch-list')
                if SEVERITY_RANK[_sev(w['severity'])] > SEVERITY_RANK[f['severity']]:
                    f['severity'] = _sev(w['severity'])
            else:
                c.hold(f'watch list {w["id"]}: {pkg} is now {ver} (recorded affected: {w["affected_versions"]}); '
                       're-verify against the Alpine security tracker and update scanner-blind-advisories.json')
    used = set()
    rows = []
    for (aid, pkg, ver), f in sorted(found.items(), key=lambda kv: (-SEVERITY_RANK[kv[1]['severity']], kv[0])):
        sev = f['severity']
        row = {'id': aid, 'aliases': sorted(f['aliases']), 'package': pkg, 'installed': ver, 'type': f['type'],
               'severity': sev, 'fixable': f['fixable'], 'fixed_in': sorted(f['fixed_in']),
               'scanners': sorted(f['scanners']), 'decision': None, 'verdict': 'report'}
        if SEVERITY_RANK[sev] >= SEVERITY_RANK['HIGH']:
            dec = next((d for d in decisions if pkg in d['packages'] and (d['id'] == aid or d['id'] in f['aliases'])),
                       None)
            if f['fixable']:
                # Review F3: a FIXABLE High/Critical always fails, whatever the register says. A decision can only
                # cover a finding that cannot be fixed by upgrading.
                row['verdict'] = 'FAIL: fixable'
                if dec:
                    used.add((dec['id'], pkg))
                    row['decision'] = dec['owner_decision_ref']
                    c.info(f'{sev} {aid} {pkg} {ver}: owner decision {dec["owner_decision_ref"]} is IGNORED because a '
                           'fixed version exists')
            elif dec:
                used.add((dec['id'], pkg))
                row['decision'] = dec['owner_decision_ref']
                row['verdict'] = f'decided ({dec["decision"]}, expires {dec["expires"]})'
                c.info(f'{sev} {aid} {pkg} {ver}: owner decision {dec["owner_decision_ref"]} ({dec["decision"]}) '
                       f'until {dec["expires"]}')
            else:
                row['verdict'] = 'HOLD: unfixed, needs owner decision'
        rows.append(row)
    # one message per advisory and verdict (ffmpeg's four libraries share one advisory)
    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        if row['verdict'].startswith(('FAIL', 'HOLD')):
            groups.setdefault((row['id'], row['verdict'], row['severity']), []).append(row)
    for (aid, verdict, sev), rs in sorted(groups.items(), key=lambda kv: (-SEVERITY_RANK[kv[0][2]], kv[0][0])):
        pkgs = ', '.join(f'{r["package"]} {r["installed"]}' for r in rs)
        scanners = '+'.join(sorted({s for r in rs for s in r['scanners']}))
        if verdict.startswith('FAIL'):
            fixed = ', '.join(sorted({v for r in rs for v in r['fixed_in']})) or '?'
            c.fail(f'fixable {sev} {aid} in {pkgs} (fixed in {fixed}; {scanners}): rebuild/upgrade, or record an owner '
                   'decision')
        else:
            c.hold(f'unfixed {sev} {aid} in {pkgs} ({scanners}): no fixed version available; needs an explicit owner '
                   'risk decision before release')
    for d in decisions:
        for p in d['packages']:
            if (d['id'], p) not in used:
                c.info(f'decision {d["owner_decision_ref"]} for {d["id"]} / {p} matches no current finding '
                       '(remove it when it is no longer needed)')
    counts: dict[str, int] = {}
    for r in rows:
        counts[r['severity']] = counts.get(r['severity'], 0) + 1
    distinct_hc = sorted({r['id'] for r in rows if SEVERITY_RANK[r['severity']] >= 3})
    c.data.update(counts=counts, findings=rows, distinct_high_critical=distinct_hc,
                  by_scanner={s: sum(1 for r in rows if s in r['scanners']) for s in ('trivy', 'grype', 'watch-list')})
    c.info(f'findings by severity {counts}; distinct High/Critical advisories {len(distinct_hc)}; '
           f'per scanner {c.data["by_scanner"]}')
    with open(os.path.join(res, f'{a.role}-findings.json'), 'w', encoding='utf-8') as fh:
        json.dump(rows, fh, indent=1)


def cmd_secrets(a, c: Check) -> None:
    data = load_json(os.path.join(a.results, f'{a.role}-trivy-secret.json'))
    n = 0
    for res in data.get('Results') or []:
        for s in res.get('Secrets') or []:
            n += 1
            layer = (s.get('Layer') or {}).get('DiffID', '')[:19]
            # never print the match itself
            c.fail(f'secret finding {s.get("RuleID")} ({s.get("Severity")}, {s.get("Title")}) in {res.get("Target")}'
                   f':{s.get("StartLine")} layer {layer}')
    if not n:
        c.info('Trivy secret scanner: 0 findings in every layer (including files deleted by later layers) and the '
               'image config')
    c.data['secret_findings'] = n


# ----------------------------------------------------------------------------------------------------------- PDF
# Python port of packages/rab-worker/src/__tests__/helpers/pdf-inspect.ts (keep the two in step). It reads both
# renderers' output: Chromium (Skia/PDF: inline page /Resources, Type0/Identity-H fonts with ToUnicode, one BT..ET per
# run) and @react-pdf/renderer (PDFKit: INDIRECT page `/Resources n 0 R`, each glyph run in its own BT..ET positioned
# by `cm`, simple WinAnsi standard-14 fonts without ToUnicode, images as Flate pixels + /SMask). Also compressed object
# streams, PNG predictors, inherited resources, Form XObjects and literal strings. Not a general PDF parser: no
# encryption (refused), no Type3 glyph programs, no non-Identity CID CMaps, no LZW/ASCII85/RunLength filters.
class _PdfName(str):
    """A PDF name (str subclass so it compares to plain strings)."""


class _PdfRef(int):
    """An indirect reference `n g R` (the object number)."""


class _PdfStr(bytes):
    """A PDF string's bytes."""


class _PdfOp(str):
    """A content-stream operator or unknown keyword."""


_PDF_WS = frozenset(b'\x00\t\n\x0c\r ')
_PDF_DELIM = frozenset(b'()<>[]{}/%')
_ARR_END, _DICT_END, _EOF = object(), object(), object()
_PDF_NUM = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)$')
_PDF_EI = re.compile(r'\sEI(?=[\s/\[<(%]|$)')


class _PdfLexer:
    def __init__(self, s: str):
        self.s, self.pos = s, 0

    def _skip(self):
        s, n = self.s, len(self.s)
        while self.pos < n:
            c = ord(s[self.pos])
            if c in _PDF_WS:
                self.pos += 1
            elif c == 0x25:  # %
                while self.pos < n and s[self.pos] not in '\r\n':
                    self.pos += 1
            else:
                break

    def _literal(self) -> _PdfStr:
        s, out, depth = self.s, bytearray(), 1
        self.pos += 1
        esc = {'n': 10, 'r': 13, 't': 9, 'b': 8, 'f': 12, '(': 40, ')': 41, '\\': 92}
        while self.pos < len(s):
            ch = s[self.pos]
            self.pos += 1
            if ch == '\\':
                e = s[self.pos] if self.pos < len(s) else ''
                self.pos += 1
                if e in esc:
                    out.append(esc[e])
                elif e and e in '01234567':
                    octal = e
                    while len(octal) < 3 and self.pos < len(s) and s[self.pos] in '01234567':
                        octal += s[self.pos]
                        self.pos += 1
                    out.append(int(octal, 8) & 0xff)
                elif e == '\r':
                    if self.pos < len(s) and s[self.pos] == '\n':
                        self.pos += 1
                elif e and e != '\n':
                    out.append(ord(e) & 0xff)
                continue
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    break
            out.append(ord(ch) & 0xff)
        return _PdfStr(bytes(out))

    def _raw(self):
        self._skip()
        s = self.s
        if self.pos >= len(s):
            return _EOF
        c = s[self.pos]
        if c == '(':
            return self._literal()
        if c == '<':
            if s[self.pos + 1:self.pos + 2] == '<':
                self.pos += 2
                d: dict = {}
                while True:
                    k = self.value()
                    if k is _DICT_END or k is _EOF:
                        return d
                    if not isinstance(k, _PdfName):
                        continue
                    v = self.value()
                    if v is _DICT_END or v is _EOF:
                        return d
                    if v is not _ARR_END:
                        d[str(k)] = v
            end = s.find('>', self.pos)
            end = len(s) if end < 0 else end
            hx = re.sub(r'[^0-9A-Fa-f]', '', s[self.pos + 1:end])
            self.pos = min(len(s), end + 1)
            return _PdfStr(bytes.fromhex(hx + ('0' if len(hx) % 2 else '')))
        if c == '>' and s[self.pos + 1:self.pos + 2] == '>':
            self.pos += 2
            return _DICT_END
        if c == '[':
            self.pos += 1
            arr: list = []
            while True:
                v = self.value()
                if v is _ARR_END or v is _EOF:
                    return arr
                if v is not _DICT_END:
                    arr.append(v)
        if c == ']':
            self.pos += 1
            return _ARR_END
        end = self.pos + 1 if c == '/' else self.pos
        while end < len(s) and ord(s[end]) not in _PDF_WS and ord(s[end]) not in _PDF_DELIM:
            end += 1
        if c == '/':
            name = re.sub(r'#([0-9A-Fa-f]{2})', lambda m: chr(int(m[1], 16)), s[self.pos + 1:end])
            self.pos = end
            return _PdfName(name)
        if end == self.pos:
            end += 1  # a stray delimiter such as `{`, `}` or a lone `>`
        word = s[self.pos:end]
        self.pos = end
        if _PDF_NUM.match(word):
            return float(word) if '.' in word else int(word)
        return {'true': True, 'false': False, 'null': None}.get(word, _PdfOp(word))

    def value(self):
        """Next value, folding `n g R` into a reference (look-ahead with backtracking)."""
        v = self._raw()
        if type(v) is not int:
            return v
        save = self.pos
        g = self._raw()
        if type(g) is int:
            r = self._raw()
            if isinstance(r, _PdfOp) and r == 'R':
                return _PdfRef(v)
        self.pos = save
        return v

    def skip_inline_image(self):
        m = _PDF_EI.search(self.s, self.pos)
        self.pos = m.end() if m else len(self.s)


def _pdf_value(text: str):
    v = _PdfLexer(text).value()
    return None if v is _ARR_END or v is _DICT_END or v is _EOF else v


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _arr(v) -> list:
    return [] if v is None else v if isinstance(v, list) else [v]


def _png_unpredict(data: bytes, parms) -> bytes:
    parms = parms if isinstance(parms, dict) else {}
    if (_num(parms.get('Predictor')) or 1) < 10:
        return data
    colors = int(_num(parms.get('Colors')) or 1)
    bpc = int(_num(parms.get('BitsPerComponent')) or 8)
    cols = int(_num(parms.get('Columns')) or 1)
    bpp = max(1, (colors * bpc + 7) // 8)
    row_len = (colors * bpc * cols + 7) // 8
    out = bytearray()
    prev = bytearray(row_len)
    for r in range(len(data) // (row_len + 1)):
        t = data[r * (row_len + 1)]
        src = data[r * (row_len + 1) + 1:(r + 1) * (row_len + 1)]
        row = bytearray(row_len)
        for i in range(row_len):
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            x = src[i]
            if t == 1:
                x += a
            elif t == 2:
                x += b
            elif t == 3:
                x += (a + b) >> 1
            elif t == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                x += a if pa <= pb and pa <= pc else b if pb <= pc else c
            row[i] = x & 0xff
        out += row
        prev = row
    return bytes(out)


def _pdf_decode_stream(dict_text: str, raw: bytes) -> bytes:
    import zlib
    d = _pdf_value(dict_text)
    if not isinstance(d, dict):
        return raw
    filters = [str(f) for f in _arr(d.get('Filter')) if isinstance(f, _PdfName)]
    parms = _arr(d.get('DecodeParms'))
    data = raw
    for i, f in enumerate(filters):
        if f not in ('FlateDecode', 'Fl'):
            return data  # e.g. DCTDecode: keep the encoded bytes
        try:
            data = zlib.decompress(data)
        except zlib.error:
            return data
        data = _png_unpredict(data, parms[i] if i < len(parms) else None)
    return data


def _pdf_objects(pdf: bytes) -> dict:
    """Object number -> (source text before `stream`, decoded stream bytes or None), object streams expanded."""
    text = pdf.decode('latin1')
    if re.search(r'/Encrypt\s+\d+\s+\d+\s+R', text):
        raise ValueError('encrypted PDF: not supported')
    objs: dict = {}
    rx = re.compile(r'(\d+)\s+\d+\s+obj\b\s*')
    pos = 0
    while True:
        m = rx.search(text, pos)
        if not m:
            break
        start = m.end()
        end = text.find('endobj', start)
        if end < 0:
            break
        body = text[start:end]
        sm = re.search(r'>>\s*stream\r?\n', body)
        if not sm:
            objs[int(m[1])] = (body, None)
            pos = end
            continue
        hdr = re.search(r'stream\r?\n', body[sm.start():])
        data_start = start + sm.start() + hdr.end()
        d = body[:sm.start() + 2]
        # A direct /Length is authoritative when `endstream` really follows it (binary data may contain "endstream").
        ln = re.search(r'/Length\s+(\d+)(?!\s+\d+\s+R)', d)
        if ln and re.match(r'\s*endstream', text[data_start + int(ln[1]):data_start + int(ln[1]) + 12]):
            data_end = data_start + int(ln[1])
        else:
            data_end = text.find('endstream', data_start)
            if data_end < 0:
                break
            if pdf[data_end - 1:data_end] == b'\n':
                data_end -= 1
            if pdf[data_end - 1:data_end] == b'\r':
                data_end -= 1
        objs[int(m[1])] = (d, _pdf_decode_stream(d, pdf[data_start:data_end]))
        pos = text.find('endobj', data_end)
        if pos < 0:
            break
    # Compressed object streams (PDF 1.5+): their members are objects too. A directly written object wins.
    for d, stream in list(objs.values()):
        if stream is None or not re.search(r'/Type\s*/ObjStm\b', d):
            continue
        sd = _pdf_value(d)
        if not isinstance(sd, dict):
            continue
        n, first = int(_num(sd.get('N')) or 0), int(_num(sd.get('First')) or 0)
        data = stream.decode('latin1')
        head = [int(x) for x in data[:first].split()]
        for i in range(n):
            oid, s0 = head[2 * i], first + head[2 * i + 1]
            s1 = first + head[2 * i + 3] if i + 1 < n else len(data)
            objs.setdefault(oid, (data[s0:s1], None))
    return objs


class _PdfDoc:
    def __init__(self, objs: dict):
        self.objs, self._cache = objs, {}

    def value(self, oid: int):
        if oid not in self._cache:
            o = self.objs.get(oid)
            self._cache[oid] = _pdf_value(o[0]) if o else None
        return self._cache[oid]

    def resolve(self, v):
        for _ in range(32):
            if not isinstance(v, _PdfRef):
                return v
            v = self.value(int(v))
        return None

    def dict(self, v):
        r = self.resolve(v)
        return r if isinstance(r, dict) else None

    def stream(self, v):
        return self.objs.get(int(v), ('', None))[1] if isinstance(v, _PdfRef) else None


def _to_unicode(cmap: str):
    m: dict = {}

    def h2s(h: str) -> str:
        if len(h) % 4:
            h = h.zfill(-(-len(h) // 4) * 4)
        return bytes.fromhex(h).decode('utf-16-be', errors='replace') if h else ''

    cs = re.search(r'begincodespacerange\s*<([0-9A-Fa-f]+)>', cmap)
    for blk in re.findall(r'beginbfchar(.*?)endbfchar', cmap, re.S):
        for a, b in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>', blk):
            m[int(a, 16)] = h2s(b)
    for blk in re.findall(r'beginbfrange(.*?)endbfrange', cmap, re.S):
        for lo, hi, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])', blk):
            a, b = int(lo, 16), int(hi, 16)
            if b - a > 0xffff:
                continue
            if dst.startswith('['):
                items = [h2s(x) for x in re.findall(r'<([0-9A-Fa-f]*)>', dst)]
                for c in range(a, b + 1):
                    m[c] = items[c - a] if c - a < len(items) else ''
            else:
                # The destination's LAST UTF-16 unit is incremented across the range.
                base = h2s(dst[1:-1])
                for c in range(a, b + 1):
                    m[c] = base[:-1] + chr(ord(base[-1]) + c - a) if base else ''
    return m, (len(cs[1]) // 2 if cs else None)


def _glyph_name(name: str) -> str:
    m = re.match(r'^uni([0-9A-Fa-f]{4})$', name) or re.match(r'^u([0-9A-Fa-f]{4,6})$', name)
    if m:
        return chr(int(m[1], 16))
    return name if len(name) == 1 else '�'


_UNKNOWN_FONT = (2, lambda c: '�', lambda c: None)


def _pdf_font(doc: _PdfDoc, ref):
    """(bytes per code, decode(code) -> str, width(code) -> glyph-space width or None)."""
    font = doc.dict(ref)
    if font is None:
        return _UNKNOWN_FONT
    tus = doc.stream(font.get('ToUnicode'))
    tu, tu_bytes = _to_unicode(tus.decode('latin1')) if tus else ({}, None)
    if font.get('Subtype') == 'Type0':
        cid = doc.dict((_arr(doc.resolve(font.get('DescendantFonts'))) or [None])[0]) or {}
        widths: dict = {}
        w = [doc.resolve(x) for x in _arr(doc.resolve(cid.get('W')))]
        i = 0
        while i < len(w) and _num(w[i]) is not None:
            first = int(w[i])
            nxt = w[i + 1] if i + 1 < len(w) else None
            if isinstance(nxt, list):
                for k, x in enumerate(nxt):
                    x = doc.resolve(x)
                    if _num(x) is not None:
                        widths[first + k] = x
                i += 2
            else:
                v = w[i + 2] if i + 2 < len(w) else None
                if _num(nxt) is None or _num(v) is None:
                    break
                for c in range(first, min(int(nxt), first + 0xffff) + 1):
                    widths[c] = v
                i += 3
        dw = _num(doc.resolve(cid.get('DW')))
        dw = 1000 if dw is None else dw
        # Identity-H/V: CID = code, read at the ToUnicode codespace width (2 bytes for both renderers).
        return (tu_bytes or 2, lambda c: tu.get(c, '�'), lambda c: widths.get(c, dw))
    # Simple font (Type1 / TrueType): one byte per code; ToUnicode, else /Differences, else the base encoding.
    codec = 'cp1252'
    diffs: dict = {}
    enc = doc.resolve(font.get('Encoding'))
    if isinstance(enc, _PdfName):
        codec = 'mac_roman' if enc == 'MacRomanEncoding' else 'cp1252'
    elif isinstance(enc, dict):
        codec = 'mac_roman' if enc.get('BaseEncoding') == 'MacRomanEncoding' else 'cp1252'
        code = 0
        for x in _arr(doc.resolve(enc.get('Differences'))):
            if _num(x) is not None:
                code = int(x)
            elif isinstance(x, _PdfName):
                diffs[code] = _glyph_name(str(x))
                code += 1
    first_char = int(_num(doc.resolve(font.get('FirstChar'))) or 0)
    wl = [doc.resolve(x) for x in _arr(doc.resolve(font.get('Widths')))]
    has_widths = 'Widths' in font

    def width(c):
        if not has_widths:
            return None  # standard 14 font: the PDF does not carry the widths
        v = wl[c - first_char] if 0 <= c - first_char < len(wl) else None
        return v if _num(v) is not None else 0

    def decode(c):
        if c in tu:
            return tu[c]
        if c in diffs:
            return diffs[c]
        return bytes([c]).decode(codec, errors='replace')

    return (1, decode, width)


def _mul(m, n):
    return (m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
            m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5])


_IDENTITY = (1, 0, 0, 1, 0, 0)


def _pdf_scan(doc: _PdfDoc, content: str, resources, base_ctm, runs: list, counter: list, depth: int, seen: set):
    """Appends one dict per shown text run: text, text object index, device-space origin, end point and font size."""
    fonts_d = doc.dict((resources or {}).get('Font')) or {}
    xobjs = doc.dict((resources or {}).get('XObject')) or {}
    cache: dict = {}
    # q/Q save and restore the CTM and the text state (font, size, spacing, scaling, leading); not the text matrix.
    gs = dict(ctm=base_ctm, font=_UNKNOWN_FONT, size=0, tc=0, tw=0, th=1, tl=0)
    stack: list = []
    tm = tlm = _IDENTITY
    in_text, tobj = False, -1

    def show(parts):
        nonlocal tm
        if not in_text:
            return
        nbytes, decode, width = gs['font']
        start = _mul(tm, gs['ctm'])
        text, measurable = '', True
        for p in parts:
            if _num(p) is not None:
                tm = _mul((1, 0, 0, 1, -p / 1000 * gs['size'] * gs['th'], 0), tm)
                continue
            if not isinstance(p, _PdfStr):
                continue
            for i in range(0, len(p) - nbytes + 1, nbytes):
                code = int.from_bytes(p[i:i + nbytes], 'big')
                text += decode(code)
                w = width(code)
                if w is None:
                    measurable = False
                tx = ((w or 0) / 1000 * gs['size'] + gs['tc'] + (gs['tw'] if nbytes == 1 and code == 32 else 0)) * gs['th']
                tm = _mul((1, 0, 0, 1, tx, 0), tm)
        if text:
            e = _mul(tm, gs['ctm'])
            runs.append(dict(text=text, tobj=tobj, x=start[4], y=start[5], end=(e[4], e[5]) if measurable else None,
                             size=abs(gs['size']) * (start[2] ** 2 + start[3] ** 2) ** 0.5))

    lx = _PdfLexer(content)
    ops: list = []

    def n(i):
        return (_num(ops[-i]) or 0) if len(ops) >= i else 0

    while True:
        v = lx.value()
        if v is _EOF:
            break
        if v is _ARR_END or v is _DICT_END:
            continue
        if not isinstance(v, _PdfOp):
            ops.append(v)
            continue
        op = str(v)
        if op == 'q':
            stack.append(dict(gs))
        elif op == 'Q':
            gs = stack.pop() if stack else dict(gs, ctm=base_ctm)
        elif op == 'cm':
            gs['ctm'] = _mul((n(6), n(5), n(4), n(3), n(2), n(1)), gs['ctm'])
        elif op == 'BT':
            in_text, tm, tlm = True, _IDENTITY, _IDENTITY
            tobj = counter[0]
            counter[0] += 1
        elif op == 'ET':
            in_text = False
        elif op == 'Tf':
            name = ops[-2] if len(ops) >= 2 else None
            if isinstance(name, _PdfName):
                if name not in cache:
                    cache[name] = _pdf_font(doc, fonts_d[name]) if name in fonts_d else _UNKNOWN_FONT
                gs['font'] = cache[name]
            else:
                gs['font'] = _UNKNOWN_FONT
            gs['size'] = n(1)
        elif op in ('Tc', 'Tw', 'TL'):
            gs[op.lower()] = n(1)
        elif op == 'Tz':
            gs['th'] = n(1) / 100
        elif op in ('Td', 'TD'):
            if op == 'TD':
                gs['tl'] = -n(1)
            tlm = _mul((1, 0, 0, 1, n(2), n(1)), tlm)
            tm = tlm
        elif op == 'Tm':
            tlm = tm = (n(6), n(5), n(4), n(3), n(2), n(1))
        elif op in ('T*', "'", '"'):
            if op == '"':
                gs['tw'], gs['tc'] = n(3), n(2)
            tlm = _mul((1, 0, 0, 1, 0, -gs['tl']), tlm)
            tm = tlm
            if op != 'T*':
                show([ops[-1] if ops else None])
        elif op == 'Tj':
            show([ops[-1] if ops else None])
        elif op == 'TJ':
            if ops and isinstance(ops[-1], list):
                show(ops[-1])
        elif op == 'Do':
            ref = xobjs.get(ops[-1]) if ops and isinstance(ops[-1], _PdfName) else None
            xo = doc.dict(ref) if isinstance(ref, _PdfRef) else None
            if xo and xo.get('Subtype') == 'Form' and depth < 12 and int(ref) not in seen:
                fm = [_num(doc.resolve(x)) or 0 for x in _arr(doc.resolve(xo.get('Matrix')))]
                body = (doc.stream(ref) or b'').decode('latin1')
                seen.add(int(ref))
                _pdf_scan(doc, body, doc.dict(xo.get('Resources')) or resources,
                          _mul(tuple(fm) if len(fm) == 6 else _IDENTITY, gs['ctm']), runs, counter, depth + 1, seen)
                seen.discard(int(ref))
        elif op == 'ID':
            lx.skip_inline_image()
        ops = []


def _pdf_lines(runs: list) -> list:
    """One line per text object (Chromium), joining a run that continues the previous one on the same baseline with no
    gap (react-pdf: "5" + "h 28m"); a new baseline inside one text object also starts a new line."""
    lines, line, prev = [], '', None
    for r in runs:
        cont = False
        if prev:
            tol = max(r['size'], prev['size']) * 0.1
            if r['tobj'] == prev['tobj']:
                base = prev['end'][1] if prev['end'] else prev['y']
                cont = abs(r['y'] - base) <= max(tol, 0.01)
            elif prev['end']:
                cont = abs(r['y'] - prev['end'][1]) <= tol and abs(r['x'] - prev['end'][0]) <= tol
        if not cont and line:
            lines.append(line)
            line = ''
        line += r['text']
        prev = r
    if line:
        lines.append(line)
    return lines


def inspect_pdf(pdf: bytes) -> dict:
    """Page count, text (decoded through each font's ToUnicode CMap or a simple font's encoding; whitespace collapsed),
    text per page and the number of embedded raster images (soft masks excluded), like the repo's pdf-inspect helper."""
    if pdf[:5] != b'%PDF-':
        raise ValueError('not a PDF (no %PDF- header)')
    if b'%%EOF' not in pdf[-1024:]:
        raise ValueError('PDF has no %%EOF trailer (truncated)')
    doc = _PdfDoc(_pdf_objects(pdf))
    pages: list = []
    seen: set = set()

    def walk(ref, inherited, depth=0):
        if not isinstance(ref, _PdfRef) or int(ref) in seen or depth > 64:
            return
        seen.add(int(ref))
        node = doc.dict(ref)
        if node is None:
            return
        res = doc.dict(node.get('Resources')) if 'Resources' in node else inherited
        if node.get('Type') == 'Pages':
            for k in _arr(doc.resolve(node.get('Kids'))):
                walk(k, res, depth + 1)
        elif node.get('Type') == 'Page':
            pages.append((node, res))

    catalog = next((i for i, (d, _) in doc.objs.items() if re.search(r'/Type\s*/Catalog\b', d)), None)
    if catalog is not None:
        walk((doc.dict(_PdfRef(catalog)) or {}).get('Pages'), None)
    texts = []
    for node, res in pages:
        contents: list = []
        for c in _arr(node.get('Contents')):
            r = doc.resolve(c) if isinstance(c, _PdfRef) else None
            contents += r if isinstance(r, list) else [c]
        content = '\n'.join((doc.stream(c) or b'').decode('latin1') for c in contents)
        runs: list = []
        _pdf_scan(doc, content, res, _IDENTITY, runs, [0], 0, set())
        texts.append('\n'.join(_pdf_lines(runs)))
    # A soft mask is itself an /Image referenced via /SMask from its colour image: count only the colour image.
    masks = {int(x) for d, _ in doc.objs.values() for x in re.findall(r'/SMask\s+(\d+)\s+\d+\s+R', d)}
    images = sum(1 for i, (d, _) in doc.objs.items() if re.search(r'/Subtype\s*/Image\b', d) and i not in masks)
    return {'pages': len(pages), 'text': re.sub(r'\s+', ' ', '\n'.join(texts)).strip(), 'images': images,
            'page_texts': texts}


# O1: the Worker's jobs runtime contract, exactly as the production compose runs it (docker-compose.image.yml rab-worker:
# `node packages/rab-worker/dist/main.js` as 1000:1000 with these variables and a tmpfs on each jobs directory;
# scripts/compose-owner-login.cjs enforces the user, HOME and the heartbeat path there). It replaces the retired launcher's
# jobs-child plan, which computed the same values.
WORKER_JOBS_UID, WORKER_JOBS_GID = 1000, 1000
WORKER_JOBS_ENV = {
    'HOME': '/nonexistent',
    'TMPDIR': '/tmp/crewflow-jobs',
    'XDG_CONFIG_HOME': '/tmp/crewflow-jobs/.config',
    'XDG_CACHE_HOME': '/tmp/crewflow-jobs/.cache',
    'CREWFLOW_INSTANCE_HEALTH_FILE': '/run/crewflow-health/jobs/heartbeat.json',
}


def cmd_pdf(a, c: Check) -> None:
    """PDF render of a real report through the production (native, Chromium-free) renderer inside the exact gated image,
    as the Worker runs it (uid 1000, the jobs environment and tmpfs mounts of the production compose), on a host of the
    image's own architecture."""
    import base64
    rp = role_policy(a.role)
    if not rp.get('pdf_render'):
        c.fail(f'role {a.role} does not render PDFs; the PDF render gate applies to the image that runs the Worker')
        return
    smoke = os.path.join(HERE, 'pdf-render-smoke.cjs')
    hard = ['run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt',
            'no-new-privileges', '--read-only', *_mount(smoke, '/gate/pdf-render-smoke.cjs')]
    # 1. The Worker's jobs environment (fixed contract above). P5: the image itself must carry no browser setting either.
    env = dict(WORKER_JOBS_ENV)
    cfg_env = (inspect_image(a.image).get('Config') or {}).get('Env') or []
    leaked = sorted(e.partition('=')[0] for e in cfg_env if e.partition('=')[0].startswith(('CHROMIUM_', 'PLAYWRIGHT_')))
    if leaked:
        c.fail(f'the image config still sets browser settings: {leaked} (P5: no browser)')
    c.info(f'Worker jobs contract: uid {WORKER_JOBS_UID} gid {WORKER_JOBS_GID} HOME={env["HOME"]} TMPDIR={env["TMPDIR"]} '
           f'XDG_CONFIG_HOME={env["XDG_CONFIG_HOME"]} XDG_CACHE_HOME={env["XDG_CACHE_HOME"]}')
    uid, gid = WORKER_JOBS_UID, WORKER_JOBS_GID
    # 2. Runtime facts: the kernel architecture the image ran on and the Node that rendered (the renderer is JavaScript).
    u = docker('run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'uname', a.image, '-m',
               check=False).stdout.strip()
    nv = docker('run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', f'{uid}:{gid}',
                '--entrypoint', 'node', a.image, '--version', check=False).stdout.strip()
    img = inspect_image(a.image)
    # Native, not emulated: inside a QEMU-emulated container `uname -m` also says aarch64, so compare the image's
    # architecture with the Docker host's own.
    host = docker('info', '--format', '{{.Architecture}}', check=False).stdout.strip()
    native = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(host) == img.get('Architecture')
    facts = dict(image=a.image, image_id=img['Id'], repo_digests=img.get('RepoDigests'),
                 platform=f'{img.get("Os")}/{img.get("Architecture")}', uname_m=u, docker_host_arch=host,
                 native=native, node=nv)
    c.data.update(facts)
    if not native:
        c.fail(f'the {img.get("Architecture")} image ran on a {host!r} Docker host (emulated): not a native render')
    # 3. The render, as that child, with the production compose runtime settings (read-only root, per-child tmpfs,
    #    no capabilities, no-new-privileges, no network).
    envargs = [x for k, v in env.items() for x in ('-e', f'{k}={v}')]
    p = docker(*hard, '--user', f'{uid}:{gid}', '--workdir', '/app',
               '--tmpfs', f'/tmp/crewflow-jobs:uid={uid},gid={gid},mode=0700',
               '--tmpfs', f'/run/crewflow-health/jobs:uid={uid},gid={gid},mode=0755',
               *envargs, '--entrypoint', 'node', a.image, '/gate/pdf-render-smoke.cjs', 'render',
               check=False, timeout=600)
    try:
        run = json.loads(p.stdout)
    except ValueError:
        c.fail(f'PDF render failed (exit {p.returncode}) on {u} ({"native" if native else "EMULATED"}): '
               f'{(p.stderr or p.stdout)[-800:]}')
        with open(os.path.join(a.results, f'{a.role}-pdf-run.json'), 'w', encoding='utf-8') as f:
            json.dump(dict(facts, render='FAILED', stderr_tail=(p.stderr or '')[-2000:]), f, indent=2)
        return
    run.update(facts)
    pdf = base64.b64decode(run.pop('pdf_b64'))
    with open(os.path.join(a.results, f'{a.role}-render.pdf'), 'wb') as f:
        f.write(pdf)
    run['pdf_sha256'] = hashlib.sha256(pdf).hexdigest()
    # 4. Validate the PDF outside the image under test.
    try:
        info = inspect_pdf(pdf)
    except ValueError as e:
        c.fail(f'render output is not a valid PDF: {e}')
        info = {'pages': 0, 'text': '', 'images': 0}
    run.update(pdf_pages=info['pages'], pdf_images=info['images'], pdf_text_chars=len(info['text']))
    with open(os.path.join(a.results, f'{a.role}-pdf-run.json'), 'w', encoding='utf-8') as f:
        json.dump(run, f, indent=2)
    c.data.update(run)
    want_arch = {'amd64': 'x86_64', 'arm64': 'aarch64'}.get(img.get('Architecture'))
    if u != want_arch:
        c.fail(f'uname -m inside the {img.get("Architecture")} image is {u!r}, expected {want_arch}')
    if info['pages'] < 1:
        c.fail('the PDF has no pages')
    for needle in (f'{run.get("marker")} Venue', 'Alex Example', 'H5-SMOKE-0001', '<script>alert(1)</script>',
                   '<img src="http://example.invalid/x.png">'):
        if needle not in info['text']:
            c.fail(f'expected text not found in the PDF: {needle!r}')
    if info['images'] < 1:
        c.fail('no embedded image (logo / QR) in the PDF')
    c.info(f'{u}: node {nv}, renderer {run.get("renderer")}; rendered {run["bytes"]} bytes, {info["pages"]} page(s), {info["images"]} image object(s) in '
           f'{run["render_ms"]} ms as uid {run["uid"]} (HOME={run["home"]}, TMPDIR={run["tmpdir"]}); markup in the '
           'synthetic names came out as literal text')


# ----------------------------------------------------------------------------------------------------------- OCI
def blob(layout: str, digest: str) -> bytes:
    if not DIGEST_RE.fullmatch(digest):
        raise ValueError(f'bad digest {digest!r}')
    path = os.path.join(layout, 'blobs', 'sha256', digest.split(':', 1)[1])
    with open(path, 'rb') as f:
        data = f.read()
    if 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f'blob {digest} in {layout} does not match its digest')
    return data


def layout_entries(layout: str) -> tuple[str | None, list[dict]]:
    """Top-level index.json -> (image index digest or None, [descriptors of image + attestation manifests])."""
    idx = load_json(os.path.join(layout, 'index.json'))
    ms = idx.get('manifests') or []
    if len(ms) != 1:
        raise ValueError(f'{layout}/index.json lists {len(ms)} entries, expected 1')
    top = ms[0]
    if top['mediaType'] in ('application/vnd.oci.image.index.v1+json',
                            'application/vnd.docker.distribution.manifest.list.v2+json'):
        inner = json.loads(blob(layout, top['digest']))
        return top['digest'], inner.get('manifests') or []
    return None, [top]


def is_attestation(desc: dict) -> bool:
    return (desc.get('annotations') or {}).get('vnd.docker.reference.type') == 'attestation-manifest'


def plat(desc: dict) -> str:
    p = desc.get('platform') or {}
    return '/'.join(x for x in (p.get('os'), p.get('architecture')) if x)


SECRET_TEXT = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|'
                         r'-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}|://[^/\s:@"]+:[^/\s@"]+@')


def cmd_attest(a, c: Check) -> None:
    rp = role_policy(a.role)
    try:
        index_digest, entries = layout_entries(a.layout)
    except (OSError, ValueError, KeyError) as e:
        c.fail(f'cannot read the OCI layout: {e}')
        return
    images = [d for d in entries if not is_attestation(d)]
    # A per-platform build output holds one image; a gated multi-platform candidate holds one per platform.
    mine = [d for d in images if plat(d) == a.platform] if len(images) > 1 else images
    if len(mine) != 1 or plat(mine[0]) not in ('', a.platform):
        c.fail(f'expected exactly one {a.platform} image manifest in the build output, found '
               f'{[plat(d) for d in images]}')
        return
    img = mine[0]
    manifest = json.loads(blob(a.layout, img['digest']))
    config_digest = manifest['config']['digest']
    cfg = json.loads(blob(a.layout, config_digest))
    # Identity: Docker's image ID is the config digest (classic store) or the manifest/index digest (containerd store);
    # either way the loaded image's layer chain must equal the build output's.
    if a.image_id not in (config_digest, img['digest'], index_digest):
        c.fail(f'the build output image (config {config_digest}, manifest {img["digest"]}) is not the gated image '
               f'{a.image_id}')
    if a.image:
        loaded = inspect_image(a.image)
        if loaded['Id'] != a.image_id:
            c.fail(f'{a.image} is {loaded["Id"]}, not the gated {a.image_id}')
        if loaded['RootFS']['Layers'] != (cfg.get('rootfs') or {}).get('diff_ids'):
            c.fail(f'{a.image} has a different layer chain than the build output')
        else:
            c.info(f'{a.image} = build output (config {config_digest}, {len(loaded["RootFS"]["Layers"])} layers)')
    if f'{cfg.get("os")}/{cfg.get("architecture")}' != a.platform:
        c.fail(f'image config says {cfg.get("os")}/{cfg.get("architecture")}, expected {a.platform}')
    att = [d for d in entries if is_attestation(d)
           and (d.get('annotations') or {}).get('vnd.docker.reference.digest') == img['digest']]
    c.data.update(index_digest=index_digest, manifest_digest=img['digest'], config_digest=config_digest)
    if len(att) != 1:
        c.fail(f'expected one attestation manifest for {img["digest"]}, found {len(att)}: SBOM/provenance missing')
        return
    am = json.loads(blob(a.layout, att[0]['digest']))
    sboms, provs = [], []
    for layer in am.get('layers') or []:
        pt = (layer.get('annotations') or {}).get('in-toto.io/predicate-type', '')
        stmt = json.loads(blob(a.layout, layer['digest']))
        # BuildKit leaves the in-toto subject empty inside an attestation manifest: the binding to the image is the
        # manifest's vnd.docker.reference.digest annotation (checked above). A subject that IS present must name it.
        subjects = {s.get('digest', {}).get('sha256') for s in stmt.get('subject') or []}
        if subjects and img['digest'].split(':', 1)[1] not in subjects:
            c.fail(f'attestation {pt} names subject(s) {sorted(subjects)}, not the image manifest {img["digest"]}')
        if pt.startswith('https://spdx.dev/Document') or pt.startswith('https://cyclonedx.org/bom'):
            sboms.append(stmt)
        elif pt.startswith('https://slsa.dev/provenance/'):
            provs.append((pt, stmt))
    out = a.results
    # SBOM
    if not sboms:
        c.fail('no SBOM attestation in the build output')
    else:
        names = set()
        for s in sboms:
            pred = s.get('predicate') or {}
            for p in pred.get('packages') or pred.get('components') or []:
                if p.get('name'):
                    names.add(p['name'])
        missing = [n for n in rp['sbom_must_include'] if n not in names]
        present = sorted(n for n in names if name_matches(n, rp['sbom_must_not_include']))
        if present:
            c.fail(f'SBOM lists {present}, which must never be in this image (P5: native PDF rendering only)')
        if len(names) < rp['min_sbom_packages']:
            c.fail(f'SBOM lists only {len(names)} package names (expected >= {rp["min_sbom_packages"]})')
        if missing:
            c.fail(f'SBOM does not list {missing}')
        c.info(f'SBOM: {len(sboms)} SPDX document(s), {len(names)} distinct package names')
        with open(os.path.join(out, f'{a.role}-sbom.spdx.json'), 'w', encoding='utf-8') as f:
            json.dump([s.get('predicate') for s in sboms], f)
    # provenance
    if len(provs) != 1:
        c.fail(f'expected one SLSA provenance attestation, found {len(provs)}')
        return
    pt, stmt = provs[0]
    pred = stmt.get('predicate') or {}
    text = json.dumps(pred)
    if SECRET_TEXT.search(text):
        c.fail('provenance contains a credential-like string (token, key or URL with userinfo)')
    params = ((pred.get('invocation') or {}).get('parameters') or {}) if 'v0.2' in pt else \
        ((pred.get('buildDefinition') or {}).get('externalParameters') or {}).get('request') or {}
    allowed = set(policy()['provenance']['allowed_build_args'])
    for k in (params.get('args') or {}):
        if k.startswith('build-arg:'):
            name = k.split(':', 1)[1]
            if name not in allowed and not name.startswith('BUILDKIT_'):
                c.fail(f'provenance records build argument {name}, which the policy does not allow')
    if params.get('secrets'):
        c.fail(f'provenance lists build secrets: {[s.get("id") for s in params["secrets"]]}')
    if params.get('ssh'):
        c.fail('provenance lists SSH forwarding')
    meta = (pred.get('metadata') or {}).get('https://mobyproject.org/buildkit@v1#metadata') or \
        ((pred.get('runDetails') or {}).get('metadata') or {}).get('buildkit_metadata') or {}
    vcs = meta.get('vcs') or {}
    if vcs.get('revision') != a.revision:
        c.fail(f'provenance source revision {vcs.get("revision")!r} != commit {a.revision}')
    else:
        c.info(f'provenance ({pt}): revision {vcs.get("revision")}, source {vcs.get("source")}')
    with open(os.path.join(out, f'{a.role}-provenance.json'), 'w', encoding='utf-8') as f:
        json.dump(stmt, f, indent=1)


def cmd_manifest(a, c: Check) -> None:
    expected = sorted(a.expect_platforms.split(','))
    by_role: dict[str, list[tuple[str, str]]] = {}
    for spec in a.inputs:
        role, platform, layout = spec.split('=', 2)
        by_role.setdefault(role, []).append((platform, layout))
    digests = {}
    diff_ids: dict[tuple[str, str], list[str]] = {}
    want_digest = dict(x.split('=', 1) for x in (a.expect_digest or []))
    for role, items in sorted(by_role.items()):
        candidate = len(items) == 1 and items[0][0] == 'multi'  # an already-gated multi-platform layout: verify in place
        dest = items[0][1] if candidate else os.path.join(a.out, f'{role}-layout')
        if candidate:
            pass
        elif os.path.exists(dest):
            c.fail(f'{dest} already exists; refusing to overwrite')
            continue
        else:
            os.makedirs(os.path.join(dest, 'blobs', 'sha256'))
        merged, plats = [], []
        for platform, layout in items:
            try:
                _, entries = layout_entries(layout)
            except (OSError, ValueError, KeyError) as e:
                c.fail(f'{role} {platform}: unreadable layout: {e}')
                continue
            imgs = [d for d in entries if not is_attestation(d)]
            for d in imgs:
                p = plat(d)
                plats.append(p)
                if p != platform and not candidate:
                    c.fail(f'{role}: layout for {platform} contains an image for {p}')
                man = json.loads(blob(layout, d['digest']))
                cfg = json.loads(blob(layout, man['config']['digest']))
                if f'{cfg.get("os")}/{cfg.get("architecture")}' != p:
                    c.fail(f'{role} {p}: config says {cfg.get("os")}/{cfg.get("architecture")}')
                rev = (cfg.get('config') or {}).get('Labels', {}).get('org.opencontainers.image.revision')
                if rev != a.revision:
                    c.fail(f'{role} {p}: revision label {rev!r} != {a.revision}')
                diff_ids[(role, p)] = (cfg.get('rootfs') or {}).get('diff_ids') or []
                if not any(is_attestation(x) and (x.get('annotations') or {}).get('vnd.docker.reference.digest')
                           == d['digest'] for x in entries):
                    c.fail(f'{role} {p}: no attestation manifest (SBOM/provenance) for {d["digest"]}')
            merged.extend(entries)
            if candidate:
                continue
            for b in os.listdir(os.path.join(layout, 'blobs', 'sha256')):
                dst = os.path.join(dest, 'blobs', 'sha256', b)
                if not os.path.exists(dst):
                    shutil.copyfile(os.path.join(layout, 'blobs', 'sha256', b), dst)
        if sorted(plats) != expected:
            c.fail(f'{role}: image platforms {sorted(plats)} != expected {expected}')
        if candidate:
            try:
                top = load_json(os.path.join(dest, 'index.json'))['manifests']
                idx_digest = top[0]['digest']
                if len(top) != 1 or (top[0].get('annotations') or {}).get('org.opencontainers.image.ref.name') != 'gated':
                    c.fail(f'{role}: candidate layout is not a single index named "gated"')
                blob(dest, idx_digest)  # hash-verified
            except (OSError, ValueError, KeyError, IndexError) as e:
                c.fail(f'{role}: unreadable candidate index: {e}')
                continue
            if role in want_digest and want_digest[role] != idx_digest:
                c.fail(f'{role}: candidate index is {idx_digest}, not the requested {want_digest[role]}')
            digests[role] = {'index_digest': idx_digest, 'layout': dest,
                             'platforms': {plat(d): d['digest'] for d in merged if not is_attestation(d)}}
            c.info(f'{role}: candidate index {idx_digest} = {digests[role]["platforms"]}')
            continue
        index = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                            'manifests': merged}, separators=(',', ':')).encode()
        idx_digest = 'sha256:' + hashlib.sha256(index).hexdigest()
        with open(os.path.join(dest, 'blobs', 'sha256', idx_digest.split(':')[1]), 'wb') as f:
            f.write(index)
        with open(os.path.join(dest, 'index.json'), 'w', encoding='utf-8') as f:
            json.dump({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                       'manifests': [{'mediaType': 'application/vnd.oci.image.index.v1+json', 'digest': idx_digest,
                                      'size': len(index), 'annotations': {
                                          'org.opencontainers.image.ref.name': 'gated'}}]}, f)
        with open(os.path.join(dest, 'oci-layout'), 'w', encoding='utf-8') as f:
            json.dump({'imageLayoutVersion': '1.0.0'}, f)
        digests[role] = {'index_digest': idx_digest, 'layout': dest,
                         'platforms': {plat(d): d['digest'] for d in merged if not is_attestation(d)}}
        c.info(f'{role}: multi-platform index {idx_digest} = {digests[role]["platforms"]}')
    for role, d in digests.items():
        if role in want_digest and want_digest[role] != d['index_digest']:
            c.fail(f'{role}: index is {d["index_digest"]}, not the requested {want_digest[role]}')
    c.data['digests'] = digests
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'digests.json'), 'w', encoding='utf-8') as f:
        json.dump(digests, f, indent=2)
    gh_out = os.environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a', encoding='utf-8') as f:
            for role, d in digests.items():
                f.write(f'{role}-index-digest={d["index_digest"]}\n')


def cmd_release_manifest(a) -> int:
    """The release manifest: commit, the image's index digest, per-platform digests, SBOM/provenance references, scanner
    versions and DB timestamps, and the native PDF results, from the gated layout and the gate evidence (O1: one image)."""
    digests = load_json(a.digests)
    out = {'schema': 1, 'status': a.status, 'commit': a.commit, 'repository': a.repo, 'gate_run': a.run_url,
           'images': {}}
    for role in sorted(digests):
        d = digests[role]
        top, entries = layout_entries(d['layout'])
        platforms = {}
        for img in [e for e in entries if not is_attestation(e)]:
            p = plat(img)
            att = [e for e in entries if is_attestation(e)
                   and (e.get('annotations') or {}).get('vnd.docker.reference.digest') == img['digest']]
            refs = []
            for e in att:
                am = json.loads(blob(d['layout'], e['digest']))
                refs += [{'attestation_manifest': e['digest'], 'predicate_type':
                          (l.get('annotations') or {}).get('in-toto.io/predicate-type'), 'blob': l['digest']}
                         for l in am.get('layers') or []]
            arch = p.split('/')[1]
            ev = os.path.join(a.evidence, f'image-gate-evidence-{arch}', f'results-{arch}')
            scan = load_json(os.path.join(ev, f'{role}-scan.json'))['data'].get('scanners')                 if os.path.exists(os.path.join(ev, f'{role}-scan.json')) else None
            entry = {'manifest_digest': img['digest'], 'reference': f'{a.repo}@{img["digest"]}',
                     'attestations': refs, 'scanners': scan}
            pdf = os.path.join(ev, f'{role}-pdf-run.json')
            if os.path.exists(pdf):
                r = load_json(pdf)
                entry['native_pdf_render'] = {k: r.get(k) for k in (
                    'native', 'uname_m', 'docker_host_arch', 'node', 'renderer', 'render_ms', 'pdf_pages', 'pdf_sha256')}
            platforms[p] = entry
        # O1 (one image, two existing tag names): the same digest is published as api-<commit> and worker-<commit> until
        # O2 replaces both with one <commit> tag.
        out['images'][role] = {'tags': [f'api-{a.commit}', f'worker-{a.commit}'], 'index_digest': d['index_digest'],
                               'reference': f'{a.repo}@{d["index_digest"]}', 'platforms': platforms}
    with open(a.output, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    print(json.dumps({r: v['reference'] for r, v in out['images'].items()}, indent=1))
    return 0


def cmd_slim(a) -> int:
    """Copy an OCI layout WITHOUT its image layer blobs (indexes, manifests, configs and attestations only): enough for
    the multi-platform manifest check, a few hundred KB instead of a gigabyte per platform. Never used for publishing."""
    if os.path.exists(a.dest):
        raise SystemExit(f'{a.dest} already exists')
    os.makedirs(os.path.join(a.dest, 'blobs', 'sha256'))
    for f in ('index.json', 'oci-layout'):
        shutil.copyfile(os.path.join(a.layout, f), os.path.join(a.dest, f))

    def keep(digest: str) -> bytes:
        data = blob(a.layout, digest)
        with open(os.path.join(a.dest, 'blobs', 'sha256', digest.split(':', 1)[1]), 'wb') as fh:
            fh.write(data)
        return data

    top = load_json(os.path.join(a.layout, 'index.json'))['manifests']
    todo = [d['digest'] for d in top]
    while todo:
        doc = json.loads(keep(todo.pop()))
        if 'manifests' in doc:
            todo += [d['digest'] for d in doc['manifests']]
        if 'config' in doc:
            keep(doc['config']['digest'])
            if any(l.get('mediaType') == 'application/vnd.in-toto+json' for l in doc.get('layers') or []):
                for l in doc['layers']:
                    keep(l['digest'])
    return 0


# ----------------------------------------------------------------------------------------------------------- summary
def cmd_summary(a) -> int:
    expected = [e for e in a.expected.split(',') if e]
    lines = [f'### {a.title}', '', f'Mode: **{a.mode}**. A check that did not run counts as FAILED.', '',
             '| Check | Status | Fail | Hold | First problem |', '|---|---|---|---|---|']
    failed = 0
    results = {}
    for name in expected:
        path = os.path.join(a.results, f'{name}.json')
        if not os.path.exists(path):
            results[name] = None
            failed += 1
            lines.append(f'| {name} | **NOT RUN = FAIL** | | | the check produced no result (build failed or step '
                         'skipped) |')
            continue
        r = load_json(path)
        results[name] = r
        status = r['status']
        if status == 'FAIL':
            failed += 1
        first = (r['fails'] or r['holds'] or [''])[0].replace('|', '\\|')[:160]
        badge = {'PASS': 'PASS', 'HOLD': 'HOLD (needs owner approval; blocks a release)', 'FAIL': '**FAIL**'}[status]
        lines.append(f'| {name} | {badge} | {len(r["fails"])} | {len(r["holds"])} | {first} |')
    for name, r in results.items():
        if r and name.endswith('-vulns'):
            hc = [f for f in r['data'].get('findings', []) if SEVERITY_RANK[f['severity']] >= 3]
            lines += ['', f'#### {name}: {r["data"].get("counts")}; High/Critical:', '',
                      '| Advisory | Package | Installed | Severity | Fix | Scanners | Verdict |', '|---|---|---|---|---|---|---|']
            for f in hc:
                lines.append(f'| {f["id"]} | {f["package"]} | {f["installed"]} | {f["severity"]} | '
                             f'{", ".join(f["fixed_in"]) or "none"} | {"+".join(f["scanners"])} | {f["verdict"]} |')
        if r and name.endswith('-pdf') and r['data'].get('uname_m'):
            d = r['data']
            lines += ['', f'#### {name}: native={d.get("native")} uname -m={d.get("uname_m")} '
                          f'(Docker host {d.get("docker_host_arch")}), node {d.get("node")}, {d.get("renderer")}, render '
                          f'{d.get("render_ms", "n/a")} ms, {d.get("pdf_pages", 0)} page(s), image {d.get("image_id")}']
        if r and r.get('holds') and not name.endswith('-vulns'):
            lines += ['', f'#### {name}: held items', ''] + [f'- {h}' for h in r['holds'][:40]]
    md = '\n'.join(lines) + '\n'
    print(md)
    if a.markdown:
        with open(a.markdown, 'w', encoding='utf-8') as f:
            f.write(md)
    step = os.environ.get('GITHUB_STEP_SUMMARY')
    if step:
        with open(step, 'a', encoding='utf-8') as f:
            f.write(md)
    print(f'summary: {failed} failed or missing of {len(expected)} expected checks')
    return 1 if failed else 0


# ----------------------------------------------------------------------------------------------------------- main
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mode', choices=('pr', 'release'), default='release')
    ap.add_argument('--results', default='image-gate-results')
    ap.add_argument('--name', help='result name (default <role>-<command>)')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('static')
    p = sub.add_parser('config')
    p.add_argument('role'), p.add_argument('image')
    p.add_argument('--revision', required=True), p.add_argument('--platform', required=True)
    p.add_argument('--source')
    for n in ('container', 'fs', 'pdf'):
        p = sub.add_parser(n)
        p.add_argument('role'), p.add_argument('image')
    p = sub.add_parser('scan')
    p.add_argument('role'), p.add_argument('image'), p.add_argument('--image-id', required=True)
    p.add_argument('--trivy-cache', required=True), p.add_argument('--grype-cache', required=True)
    for n in ('vulns', 'secrets'):
        p = sub.add_parser(n)
        p.add_argument('role')
    p = sub.add_parser('attest')
    p.add_argument('role'), p.add_argument('layout'), p.add_argument('--image-id', required=True)
    p.add_argument('--image', help='the loaded image; its ID and layer chain must match the build output')
    p.add_argument('--revision', required=True), p.add_argument('--platform', required=True)
    p = sub.add_parser('manifest')
    p.add_argument('--expect-platforms', required=True), p.add_argument('--revision', required=True)
    p.add_argument('--out', required=True), p.add_argument('inputs', nargs='+')
    p.add_argument('--expect-digest', action='append', help='role=sha256:... the index must have this digest')
    p = sub.add_parser('summary')
    p.add_argument('--expected', required=True), p.add_argument('--markdown'), p.add_argument('--title',
                                                                                             default='Image gate')
    p = sub.add_parser('release-manifest')
    p.add_argument('--digests', required=True), p.add_argument('--evidence', required=True)
    p.add_argument('--commit', required=True), p.add_argument('--repo', default='docker.io/adhin007/adolphus')
    p.add_argument('--run-url', default=''), p.add_argument('--status', default='gated (not published)')
    p.add_argument('--output', required=True)
    p = sub.add_parser('slim')
    p.add_argument('layout'), p.add_argument('dest')
    a = ap.parse_args(argv)
    if a.cmd == 'slim':
        return cmd_slim(a)
    if a.cmd == 'release-manifest':
        return cmd_release_manifest(a)
    os.makedirs(a.results, exist_ok=True)
    if a.cmd == 'summary':
        return cmd_summary(a)
    name = a.name or (f'{a.role}-{a.cmd}' if hasattr(a, 'role') else a.cmd)
    c = Check(name, a.mode, a.results)
    try:
        today(a.mode)  # review F4: the self-test date override is refused outright in release mode and in CI
    except RuntimeError as e:
        c.fail(str(e))
        return c.finish()
    handler = {'static': cmd_static, 'config': cmd_config, 'container': cmd_container, 'fs': cmd_fs,
               'scan': cmd_scan, 'vulns': cmd_vulns, 'secrets': cmd_secrets,
               'attest': cmd_attest, 'manifest': cmd_manifest, 'pdf': cmd_pdf}[a.cmd]
    try:
        handler(a, c)
    except Exception as e:  # fail closed: any unexpected error is a failed check, never a pass
        c.fail(f'gate error ({type(e).__name__}): {e}')
    return c.finish()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
