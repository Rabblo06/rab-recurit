#!/usr/bin/env python3
"""Release guards for publish-image / image-security-gate (Docker hardening H5, independent review F1 and F2).

  python3 release_guard.py candidate   --repo OWNER/REPO --run-id N --sha SHA
      F1: a candidate may come ONLY from a successful run of OUR gate or publish workflow, in this repository (not a
      fork), started by workflow_dispatch from `main` or by a published rab/vX.Y.Z release, for exactly this commit.
      Image metadata (labels, provenance) is written by whoever builds the image, so it cannot prove origin. The run
      record can.

  python3 release_guard.py environment --repo OWNER/REPO --event EVENT --ref REF --sha SHA
      F2: the `release` environment must exist with at least one required reviewer AND a deployment-branch policy
      that allows only `main` (branch) and `rab/v*` (tag). The run itself must be a dispatch from refs/heads/main, or
      a release on refs/tags/rab/vX.Y.Z whose commit is on origin/main.

Any API or git error, or any unexpected answer, exits 1 (fail closed). `gh` (and `git`) can be replaced through the
GH_CMD / GIT_CMD environment variables (JSON argv prefixes) for the self-tests.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

GATE_WORKFLOWS = {'.github/workflows/image-security-gate.yaml', '.github/workflows/publish-image.yaml'}
# Only these events ever export complete gated layouts (gate dispatch; publish dispatch in candidate-verify or publish
# mode; a published release). pull_request / push runs of the gate never export layouts, so they are never candidates.
CANDIDATE_EVENTS = {'workflow_dispatch', 'release'}
RELEASE_TAG = re.compile(r'rab/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?')
ALLOWED_POLICIES = {('main', 'branch'), ('rab/v*', 'tag')}


def _cmd(var: str, default: list[str]) -> list[str]:
    raw = os.environ.get(var)
    return json.loads(raw) if raw else default


def gh_api(path: str) -> dict:
    p = subprocess.run(_cmd('GH_CMD', ['gh']) + ['api', path], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError(f'gh api {path} failed (exit {p.returncode}): {(p.stderr or p.stdout).strip()[-300:]}')
    try:
        data = json.loads(p.stdout)
    except ValueError as e:
        raise RuntimeError(f'gh api {path}: not JSON ({e})') from e
    if not isinstance(data, dict):
        raise RuntimeError(f'gh api {path}: unexpected answer')
    return data


def check_candidate_run(run: dict, repo: str, sha: str) -> list[str]:
    """Problems with a candidate-producing run (empty list = acceptable)."""
    bad = []
    full = (run.get('repository') or {}).get('full_name')
    head = (run.get('head_repository') or {}).get('full_name')
    if full != repo:
        bad.append(f'run belongs to {full!r}, not {repo}')
    if head != repo:
        bad.append(f'run head repository is {head!r} (a fork or another repository), not {repo}')
    path = str(run.get('path') or '').split('@', 1)[0]
    if path not in GATE_WORKFLOWS:
        bad.append(f'run is from workflow {path!r}, not the image gate or publish workflow')
    event = run.get('event')
    if event not in CANDIDATE_EVENTS:
        bad.append(f'run event is {event!r}; candidates come only from {sorted(CANDIDATE_EVENTS)}')
    if run.get('head_sha') != sha:
        bad.append(f'run built {run.get("head_sha")!r}, not this commit {sha}')
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        bad.append(f'run status/conclusion is {run.get("status")}/{run.get("conclusion")}, not completed/success')
    branch = run.get('head_branch') or ''
    if event == 'workflow_dispatch' and branch != 'main':
        bad.append(f'dispatched run is on {branch!r}, not main')
    if event == 'release' and not RELEASE_TAG.fullmatch(branch):
        bad.append(f'release run is on {branch!r}, not a rab/vX.Y.Z tag')
    return bad


def check_environment(env: dict, policies: dict | None) -> list[str]:
    bad = []
    reviewers = sum(len(r.get('reviewers') or []) for r in env.get('protection_rules') or []
                    if r.get('type') == 'required_reviewers')
    if reviewers < 1:
        bad.append('environment "release" has no required reviewers (publishing would need no approval)')
    dbp = env.get('deployment_branch_policy')
    if not dbp:
        bad.append('environment "release" has no deployment-branch policy (any branch could publish)')
    elif not dbp.get('custom_branch_policies') or dbp.get('protected_branches'):
        bad.append('environment "release" must use custom deployment branch/tag policies (main + rab/v*), '
                   f'got {dbp}')
    elif policies is not None:
        got = {(p.get('name'), p.get('type', 'branch')) for p in policies.get('branch_policies') or []}
        if not got or not got <= ALLOWED_POLICIES or ('main', 'branch') not in got:
            bad.append(f'environment "release" deployment policies are {sorted(got)}; allowed: exactly main (branch) '
                       'and optionally rab/v* (tag)')
    return bad


def check_ref(event: str, ref: str, on_main: bool | None) -> list[str]:
    if event == 'workflow_dispatch':
        return [] if ref == 'refs/heads/main' else [f'publishing is dispatched only from refs/heads/main, not {ref}']
    if event == 'release':
        tag = ref[len('refs/tags/'):] if ref.startswith('refs/tags/') else ''
        bad = [] if RELEASE_TAG.fullmatch(tag) else [f'release ref {ref} is not refs/tags/rab/vX.Y.Z']
        if on_main is not True:
            bad.append('the release commit is not on origin/main')
        return bad
    return [f'event {event!r} may not publish']


def commit_on_main(sha: str) -> bool:
    git = _cmd('GIT_CMD', ['git'])
    f = subprocess.run(git + ['fetch', '--no-tags', '--quiet', 'origin', 'main'], capture_output=True, text=True)
    if f.returncode != 0:
        raise RuntimeError(f'git fetch origin main failed: {f.stderr.strip()[-200:]}')
    r = subprocess.run(git + ['merge-base', '--is-ancestor', sha, 'FETCH_HEAD'], capture_output=True, text=True)
    if r.returncode not in (0, 1):
        raise RuntimeError(f'git merge-base failed: {r.stderr.strip()[-200:]}')
    return r.returncode == 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('candidate')
    p.add_argument('--repo', required=True), p.add_argument('--run-id', required=True), p.add_argument('--sha', required=True)
    p = sub.add_parser('environment')
    p.add_argument('--repo', required=True), p.add_argument('--event', required=True)
    p.add_argument('--ref', required=True), p.add_argument('--sha', required=True)
    a = ap.parse_args(argv)
    try:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', a.repo) or not re.fullmatch(r'[0-9a-f]{40}', a.sha):
            raise RuntimeError('bad --repo or --sha')
        if a.cmd == 'candidate':
            if not re.fullmatch(r'[0-9]+', a.run_id):
                raise RuntimeError(f'candidate run id {a.run_id!r} is not a number')
            run = gh_api(f'repos/{a.repo}/actions/runs/{a.run_id}')
            bad = check_candidate_run(run, a.repo, a.sha)
            ok = f'candidate run {a.run_id}: {run.get("path")} ({run.get("event")} on {run.get("head_branch")}, ' \
                 f'{run.get("head_sha")}, {run.get("conclusion")})'
        else:
            env = gh_api(f'repos/{a.repo}/environments/release')
            policies = None
            if (env.get('deployment_branch_policy') or {}).get('custom_branch_policies'):
                policies = gh_api(f'repos/{a.repo}/environments/release/deployment-branch-policies')
            bad = check_environment(env, policies)
            on_main = commit_on_main(a.sha) if a.event == 'release' else None
            bad += check_ref(a.event, a.ref, on_main)
            ok = f'environment "release" protected; {a.event} on {a.ref} may publish'
    except Exception as e:  # fail closed
        print(f'::error::release guard ({a.cmd}): {e}')
        return 1
    for b in bad:
        print(f'::error::release guard ({a.cmd}): {b}')
    if bad:
        return 1
    print(f'release guard ({a.cmd}): OK - {ok}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
