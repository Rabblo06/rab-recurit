"""Fail-closed proofs for publish-gated.sh without any network or real push: the registry client is a fake skopeo.

Each case asserts the outcome AND whether a push (`skopeo copy`) was attempted. Runs on Linux/macOS (CI); skipped on
Windows, where `bash` may resolve to WSL.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(HERE, 'publish-gated.sh')
COMMIT = 'a' * 40

FAKE = r'''#!/usr/bin/env bash
# fake skopeo: FAKE_MODE = absent | exists | error | mismatch | badlogin
echo "$*" >> "$FAKE_LOG"
cmd="$1"; shift
case "$cmd" in
  login) [ "$FAKE_MODE" = badlogin ] && { echo "unauthorized" >&2; exit 1; }; cat > /dev/null; exit 0 ;;
  logout) exit 0 ;;
  copy) touch "$FAKE_STATE/pushed"; exit 0 ;;
  inspect)
    ref="${@: -1}"
    if [ ! -e "$FAKE_STATE/pushed" ]; then
      case "$FAKE_MODE" in
        exists) echo '{"schemaVersion":2}'; exit 0 ;;
        error) echo "unauthorized: authentication required" >&2; exit 1 ;;
        *) echo "manifest unknown" >&2; exit 1 ;;
      esac
    fi
    if [ "$FAKE_MODE" = mismatch ]; then echo '{"tampered":true}'; exit 0; fi
    d="${ref##*@}"; [ "$d" = "$ref" ] && d="$FAKE_INDEX"
    cat "$FAKE_LAYOUT/blobs/sha256/${d#sha256:}"; exit 0 ;;
esac
exit 2
'''


def make_layout(root):
    blobs = os.path.join(root, 'blobs', 'sha256')
    os.makedirs(blobs)

    def put(data: bytes) -> str:
        h = hashlib.sha256(data).hexdigest()
        with open(os.path.join(blobs, h), 'wb') as f:
            f.write(data)
        return 'sha256:' + h

    child = put(json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json'}).encode())
    index = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                        'manifests': [{'digest': child, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                                       'size': 1, 'platform': {'os': 'linux', 'architecture': 'arm64'}}]}).encode()
    idx = put(index)
    with open(os.path.join(root, 'index.json'), 'w') as f:
        json.dump({'schemaVersion': 2, 'manifests': [{'digest': idx, 'size': len(index), 'annotations': {
            'org.opencontainers.image.ref.name': 'gated'}}]}, f)
    return idx


@unittest.skipIf(os.name == 'nt', 'needs a POSIX bash')
class PublishGated(unittest.TestCase):
    def run_publish(self, mode='absent', creds=True, tag=None, digest=None, dry=False, corrupt=False):
        d = tempfile.mkdtemp()
        layout = os.path.join(d, 'layout')
        idx = make_layout(layout)
        if corrupt:
            with open(os.path.join(layout, 'blobs', 'sha256', idx[7:]), 'ab') as f:
                f.write(b' ')
        fake = os.path.join(d, 'skopeo')
        with open(fake, 'w') as f:
            f.write(FAKE)
        os.chmod(fake, 0o755)
        state = os.path.join(d, 'state')
        os.makedirs(state)
        log = os.path.join(d, 'calls.log')
        env = dict(os.environ, SKOPEO=fake, FAKE_MODE=mode, FAKE_LOG=log, FAKE_STATE=state, FAKE_LAYOUT=layout,
                   FAKE_INDEX=idx, COMMIT=COMMIT, REGISTRY_REPO='docker.io/example/repo')
        env.pop('DOCKERHUB_USERNAME', None)
        env.pop('DOCKERHUB_PUSH_TOKEN', None)
        if creds:
            env.update(DOCKERHUB_USERNAME='ci-user', DOCKERHUB_PUSH_TOKEN='not-a-real-token')
        if dry:
            env['DRY_RUN'] = '1'
        p = subprocess.run(['bash', SCRIPT, layout, digest or idx, tag or f'api-{COMMIT}'], env=env,
                           capture_output=True, text=True)
        calls = ''
        if os.path.exists(log):
            with open(log) as f:
                calls = f.read()
        return p, calls

    def test_publishes_and_verifies_when_everything_holds(self):
        p, calls = self.run_publish()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('copy ', calls)
        self.assertIn('published docker.io/example/repo:api-' + COMMIT, p.stdout)

    def test_missing_secret_fails_before_any_registry_call(self):
        p, calls = self.run_publish(creds=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn('credentials are missing', p.stderr)
        self.assertEqual(calls, '')

    def test_existing_tag_is_never_overwritten(self):
        p, calls = self.run_publish(mode='exists')
        self.assertEqual(p.returncode, 1)
        self.assertIn('already exists', p.stderr)
        self.assertNotIn('copy ', calls)

    def test_unclear_registry_answer_fails_closed(self):
        p, calls = self.run_publish(mode='error')
        self.assertEqual(p.returncode, 1)
        self.assertIn('cannot tell whether', p.stderr)
        self.assertNotIn('copy ', calls)

    def test_digest_mismatch_after_push_fails(self):
        p, calls = self.run_publish(mode='mismatch')
        self.assertEqual(p.returncode, 1)
        self.assertIn('not the gated', p.stderr)

    def test_layout_not_the_gated_digest_is_refused(self):
        p, calls = self.run_publish(digest='sha256:' + 'b' * 64)
        self.assertEqual(p.returncode, 1)
        self.assertNotIn('copy ', calls)
        p, calls = self.run_publish(corrupt=True)
        self.assertEqual(p.returncode, 1)
        self.assertNotIn('copy ', calls)

    def test_only_the_two_immutable_tags(self):
        for t in ('latest', 'api-latest', 'api-' + 'b' * 40, 'worker-' + COMMIT[:12], 'other-' + COMMIT):
            p, calls = self.run_publish(tag=t)
            self.assertEqual(p.returncode, 1, t)
            self.assertNotIn('copy ', calls)

    def test_bad_login_fails(self):
        p, calls = self.run_publish(mode='badlogin')
        self.assertEqual(p.returncode, 1)
        self.assertNotIn('copy ', calls)

    def test_dry_run_makes_no_registry_call(self):
        p, calls = self.run_publish(dry=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('DRY RUN', p.stdout)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
