"""Self-tests for image_gate.py's policy logic (no Docker needed): python3 -m unittest discover -s <this dir> -v"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True  # never leave __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import image_gate as g  # noqa: E402


def run(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = g.main(argv)
    return rc, out.getvalue()


def result(results, name):
    with open(os.path.join(results, f'{name}.json'), encoding='utf-8') as f:
        return json.load(f)


class Versions(unittest.TestCase):
    def test_semver_order(self):
        order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1',
                 '1.10.0', '2.0.0']
        keys = [g.semver_key(v) for v in order]
        self.assertEqual(keys, sorted(keys))
        self.assertLess(g.semver_key('1.29.0'), g.semver_key('1.30.0'))  # never string comparison
        self.assertLess(g.semver_key('9.0.9'), g.semver_key('10.0.0'))
        with self.assertRaises(ValueError):
            g.semver_key('1.2')

    def test_numeric_version(self):
        self.assertEqual(g.numeric_version('156.0.8078.79-r0'), (156, 0, 8078, 79))
        self.assertLess(g.numeric_version('156.0.999.1'), g.numeric_version('156.0.8078.79'))
        self.assertLess(g.numeric_version('24.9.0'), g.numeric_version('24.22.1'))
        for bad in ('', 'latest', '156.x', '156'):
            with self.assertRaises(ValueError):
                g.numeric_version(bad)

    def test_npm_floor_spec(self):
        self.assertEqual(g.parse_npm_floor('prismjs@1.30.0'), ('prismjs', '1.30.0'))
        self.assertEqual(g.parse_npm_floor('@opentelemetry/core@2.8.0'), ('@opentelemetry/core', '2.8.0'))
        for bad in ('prismjs', 'prismjs@^1.30.0', 'prismjs@1.30', '*@1.0.0'):
            with self.assertRaises(ValueError):
                g.parse_npm_floor(bad)

    def test_name_matches(self):
        self.assertTrue(g.name_matches('@jest/core', ['@jest/*']))
        self.assertFalse(g.name_matches('@jestx/core', ['@jest/*']))
        self.assertTrue(g.name_matches('jest', ['jest']))
        self.assertFalse(g.name_matches('jest-worker', ['jest']))


class Decisions(unittest.TestCase):
    base = {'id': 'CVE-2026-67215', 'packages': ['cjson'], 'images': ['worker'], 'decision': 'accepted-risk',
            'owner_decision_ref': 'OWNER-2026-11-10-1', 'decided_by': 'owner', 'decided_on': '2026-11-10',
            'expires': '2027-02-10', 'justification': 'unreachable: librist only'}

    def check(self, entries, today='2026-11-20'):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'decisions.json')
            with open(path, 'w') as f:
                json.dump({'schema': 1, 'decisions': entries}, f)
            c = g.Check('t', 'pr', None)
            with mock.patch.object(g, 'DECISIONS_FILE', path), mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': today}):
                valid = g.validate_decisions(c)
            return valid, c

    def test_valid(self):
        valid, c = self.check([self.base])
        self.assertEqual(len(valid), 1)
        self.assertEqual(c.fails, [])

    def test_expired_fails(self):
        valid, c = self.check([self.base], today='2027-02-11')
        self.assertEqual(valid, [])
        self.assertTrue(any('EXPIRED' in m for m in c.fails))

    def test_too_long_fails(self):
        valid, c = self.check([dict(self.base, expires='2027-06-01')])
        self.assertEqual(valid, [])
        self.assertTrue(c.fails)

    def test_wildcards_and_missing_fields_fail(self):
        for bad in (dict(self.base, id='CVE-*'), dict(self.base, packages=['ffmpeg-*']), dict(self.base, packages='cjson'),
                    dict(self.base, owner_decision_ref=''), dict(self.base, images=['api', 'all']),
                    dict(self.base, decision='ignore')):
            valid, c = self.check([bad])
            self.assertEqual(valid, [], bad)
            self.assertTrue(c.fails, bad)

    def test_committed_register_is_empty_and_valid(self):
        c = g.Check('t', 'release', None)
        self.assertEqual(g.validate_decisions(c), [])
        self.assertEqual(c.fails, [])


def trivy_doc(vulns):
    return {'Metadata': {'ImageID': 'sha256:x'}, 'Results': [{'Type': 'alpine', 'Vulnerabilities': vulns}]}


def grype_doc(matches):
    return {'matches': matches}


class Vulns(unittest.TestCase):
    def evaluate(self, mode, trivy=(), grype=(), apk=None, decisions=(), watch=None, today='2026-11-20'):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, 'worker-trivy-vuln.json'), 'w') as f:
            json.dump(trivy_doc(list(trivy)), f)
        with open(os.path.join(d, 'worker-grype.json'), 'w') as f:
            json.dump(grype_doc(list(grype)), f)
        with open(os.path.join(d, 'worker-apk.json'), 'w') as f:
            json.dump(apk or {}, f)
        dec = os.path.join(d, 'dec.json')
        with open(dec, 'w') as f:
            json.dump({'schema': 1, 'decisions': list(decisions)}, f)
        wl = os.path.join(d, 'wl.json')
        with open(wl, 'w') as f:
            json.dump({'schema': 1, 'advisories': watch or []}, f)
        with mock.patch.object(g, 'DECISIONS_FILE', dec), mock.patch.object(g, 'WATCHLIST_FILE', wl), \
                mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': today, 'GITHUB_ACTIONS': ''}):
            rc, out = run((['--mode', mode] if mode else []) + ['--results', d, 'vulns', 'worker'])
        return rc, result(d, 'worker-vulns'), out

    fixable_high = {'VulnerabilityID': 'CVE-2026-1', 'PkgName': 'libexpat', 'InstalledVersion': '2.9.0-r0',
                    'FixedVersion': '2.10.0-r0', 'Severity': 'HIGH', 'Status': 'fixed'}
    unfixed_grype = {'vulnerability': {'id': 'CVE-2026-20002', 'severity': 'Critical', 'fix': {'state': 'unknown'}},
                     'artifact': {'name': 'glib', 'version': '2.88.1-r1', 'type': 'apk'}, 'relatedVulnerabilities': []}

    def test_fixable_high_fails_in_every_mode(self):
        for mode in ('pr', 'release'):
            rc, r, _ = self.evaluate(mode, trivy=[self.fixable_high])
            self.assertEqual((rc, r['status']), (1, 'FAIL'), mode)

    def test_unfixed_critical_holds_on_pr_and_fails_release(self):
        rc, r, _ = self.evaluate('pr', grype=[self.unfixed_grype])
        self.assertEqual((rc, r['status']), (0, 'HOLD'))
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype])
        self.assertEqual((rc, r['status']), (1, 'FAIL'))

    def test_owner_decision_covers_one_advisory_and_package_only(self):
        dec = {'id': 'CVE-2026-20002', 'packages': ['glib'], 'images': ['worker'], 'decision': 'accepted-risk',
               'owner_decision_ref': 'OWNER-1', 'decided_by': 'owner', 'decided_on': '2026-11-10',
               'expires': '2027-01-10', 'justification': 'x'}
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype], decisions=[dec])
        self.assertEqual((rc, r['status']), (0, 'PASS'))
        other = dict(self.unfixed_grype, artifact={'name': 'glib-dev', 'version': '1', 'type': 'apk'})
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype, other], decisions=[dec])
        self.assertEqual(r['status'], 'FAIL')
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype], decisions=[dec], today='2027-01-11')
        self.assertEqual(r['status'], 'FAIL')  # expired decision: finding undecided again + register failure

    def test_default_mode_is_release(self):
        rc, r, _ = self.evaluate(None, grype=[self.unfixed_grype])
        self.assertEqual((rc, r['status'], r['mode']), (1, 'FAIL', 'release'))

    def test_medium_is_reported_not_blocking(self):
        med = dict(self.fixable_high, Severity='MEDIUM')
        rc, r, _ = self.evaluate('release', trivy=[med])
        self.assertEqual((rc, r['status']), (0, 'PASS'))
        self.assertEqual(r['data']['counts'], {'MEDIUM': 1})

    def test_watch_list_adds_scanner_blind_finding(self):
        wl = [{'id': 'CVE-2026-86140', 'severity': 'High', 'packages': ['libxml2'], 'affected_versions': ['2.13.9-r2']}]
        rc, r, _ = self.evaluate('pr', apk={'libxml2': '2.13.9-r2'}, watch=wl)
        self.assertEqual(r['status'], 'HOLD')
        self.assertEqual(r['data']['distinct_high_critical'], ['CVE-2026-86140'])
        rc, r, _ = self.evaluate('release', apk={'libxml2': '2.13.9-r2'}, watch=wl)
        self.assertEqual(r['status'], 'FAIL')
        rc, r, _ = self.evaluate('pr', apk={'libxml2': '2.15.4-r0'}, watch=wl)  # version moved: re-verify
        self.assertEqual(r['status'], 'HOLD')
        self.assertTrue(any('re-verify' in h for h in r['holds']))
        rc, r, _ = self.evaluate('release', apk={}, watch=wl)  # not installed (API image): nothing
        self.assertEqual(r['status'], 'PASS')

    def test_scanner_aliases_merge(self):
        t = {'VulnerabilityID': 'CVE-2026-9', 'PkgName': 'glob', 'InstalledVersion': '10.5.0', 'FixedVersion': '',
             'Severity': 'HIGH'}
        gm = {'vulnerability': {'id': 'GHSA-aaaa-bbbb-cccc', 'severity': 'High',
                                'fix': {'state': 'fixed', 'versions': ['14.0.2']}},
              'artifact': {'name': 'glob', 'version': '10.5.0', 'type': 'npm'},
              'relatedVulnerabilities': [{'id': 'CVE-2026-9'}]}
        rc, r, _ = self.evaluate('pr', trivy=[t], grype=[gm])
        rows = r['data']['findings']
        self.assertEqual(len(rows), 1)  # one advisory, reported by both scanners
        self.assertEqual(rows[0]['scanners'], ['grype', 'trivy'])
        self.assertTrue(rows[0]['fixable'])  # either scanner knowing a fix makes it fixable
        self.assertEqual(r['status'], 'FAIL')


class Dockerfiles(unittest.TestCase):
    def pins(self, text, name='packages/rab-docker/rab/Dockerfile'):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, os.path.dirname(name)))
        with open(os.path.join(d, name), 'w') as f:
            f.write(text)
        c = g.Check('t', 'pr', None)
        with mock.patch.object(g, 'REPO', d):
            g.check_dockerfile_pins(c, [name])
        return c

    digest = '@sha256:' + 'a' * 64

    def test_pinned_and_stages_pass(self):
        c = self.pins(f'# syntax=docker/dockerfile:1{self.digest}\nFROM node:24-alpine{self.digest} AS base\n'
                      'FROM base AS build\nCOPY --from=build /a /b\nFROM base\n')
        self.assertEqual((c.fails, c.holds), ([], []))

    def test_unpinned_from_fails(self):
        for line in ('FROM node:24-alpine', 'FROM node@sha256:abc', 'FROM --platform=$BUILDPLATFORM node:24',
                     'FROM ${BASE}'):
            self.assertTrue(self.pins(f'{line}\n').fails, line)

    def test_unpinned_copy_from_and_remote_add_fail(self):
        self.assertTrue(self.pins(f'FROM a{self.digest}\nCOPY --from=busybox:latest /bin/sh /x\n').fails)
        self.assertTrue(self.pins(f'FROM a{self.digest}\nADD https://example.com/x /x\n').fails)

    def test_unpinned_frontend_holds(self):
        c = self.pins(f'# syntax=docker/dockerfile:1\nFROM a{self.digest}\n')
        self.assertEqual(c.fails, [])
        self.assertEqual(len(c.holds), 1)
        self.assertEqual(c.status, 'HOLD')
        c.mode = 'release'
        self.assertEqual(c.status, 'FAIL')

    def test_policy_allowed_arg_base(self):
        c = self.pins('ARG CREWFLOW_BASE_IMAGE\nFROM ${CREWFLOW_BASE_IMAGE}\n',
                      'packages/rab-docker/rab/Dockerfile.worker-bundle')
        self.assertEqual(c.fails, [])


class Summary(unittest.TestCase):
    def test_missing_result_is_a_failure(self):
        d = tempfile.mkdtemp()
        with contextlib.redirect_stdout(io.StringIO()):
            g.Check('a', 'pr', d).finish()
        rc, out = run(['--mode', 'pr', '--results', d, 'summary', '--expected', 'a,b'])
        self.assertEqual(rc, 1)
        self.assertIn('NOT RUN = FAIL', out)

    def test_hold_passes_pr_summary_but_not_release(self):
        d = tempfile.mkdtemp()
        c = g.Check('a', 'pr', d)
        c.hold('x')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(c.finish(), 0)
        self.assertEqual(run(['--mode', 'pr', '--results', d, 'summary', '--expected', 'a'])[0], 0)
        c = g.Check('a', 'release', d)
        c.hold('x')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(c.finish(), 1)
        self.assertEqual(run(['--mode', 'release', '--results', d, 'summary', '--expected', 'a'])[0], 1)


    def test_unexpected_error_fails_closed(self):
        d = tempfile.mkdtemp()
        rc, out = run(['--mode', 'pr', '--results', d, 'vulns', 'worker'])  # no scanner output at all
        self.assertEqual(rc, 1)
        self.assertEqual(result(d, 'worker-vulns')['status'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
