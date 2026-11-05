"""Self-tests for image_gate.py's policy logic (no Docker needed): python3 -m unittest discover -s <this dir> -v"""
import contextlib
import io
import json
import os
import re
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
        # P5: a trailing * is a plain prefix too (OS package families, per-platform binaries)
        self.assertTrue(g.name_matches('ffmpeg-libavcodec', ['ffmpeg-*']))
        self.assertTrue(g.name_matches('chromium-swiftshader', ['chromium', 'chromium-*']))
        self.assertTrue(g.name_matches('chromium', ['chromium', 'chromium-*']))
        self.assertFalse(g.name_matches('chromium-bidix', ['chromium-bidi']))
        self.assertFalse(g.name_matches('libxml2-utils', ['libxml2']))


class P5NoBrowser(unittest.TestCase):
    """P5: Chromium, Playwright and the OS packages only Chromium pulled in must never return to a runtime image."""

    BROWSER_APK = ['chromium', 'chromium-swiftshader', 'nss', 'ffmpeg-libavcodec', 'ffmpeg-libavformat',
                   'ffmpeg-libavutil', 'ffmpeg-libswresample', 'libsndfile', 'alsa-lib', 'libpulse', 'glib', 'libxml2',
                   'cups-libs', 'cjson', 'librist', 'harfbuzz', 'fontconfig', 'font-noto', 'ttf-liberation']
    BROWSER_NPM = ['playwright', 'playwright-core', 'chromium-bidi', '@playwright/test']
    # Present in the node:24-alpine base / API image today: must stay allowed, or every build would fail.
    BASE_APK = ['musl', 'busybox', 'alpine-baselayout', 'apk-tools', 'libgcc', 'libstdc++', 'tini', 'zlib',
                'libcrypto3', 'libssl3', 'ca-certificates-bundle']

    def test_every_role_forbids_the_browser_stack(self):
        for role, rp in g.policy()['roles'].items():
            for n in self.BROWSER_APK:
                self.assertTrue(g.name_matches(n, rp['forbidden_apk']), f'{role}: apk {n} not forbidden')
            for n in self.BASE_APK:
                self.assertFalse(g.name_matches(n, rp['forbidden_apk']), f'{role}: base apk {n} must stay allowed')
            for n in self.BROWSER_NPM:
                self.assertTrue(g.name_matches(n, rp['forbidden_npm']), f'{role}: npm {n} not forbidden')
            # D5/T2: the runtime helper library fontkit needs stays allowed
            self.assertFalse(g.name_matches('@swc/helpers', rp['forbidden_npm']), role)
            for n in ('chromium', 'playwright', 'playwright-core'):
                self.assertIn(n, rp['sbom_must_not_include'], role)
            self.assertIn('apk-absent:chromium', rp['floors_checks'], role)
            self.assertNotIn('apk-required:chromium', rp['floors_checks'], role)
            self.assertNotIn('chromium_binary', rp, role)
        self.assertTrue(g.policy()['roles']['image']['pdf_render'])
        # O1: ONE role (the merge of api + worker); the merge kept every Worker check.
        self.assertEqual(sorted(g.policy()['roles']), ['image'])
        self.assertGreaterEqual(g.policy()['roles']['image']['min_sbom_packages'], 300)
        self.assertNotIn('/usr/lib/chromium', g.policy()['filesystem']['code_paths'])
        self.assertNotIn('MIN_CHROMIUM_VERSION', g.policy()['provenance']['allowed_build_args'])

    def test_static_refuses_a_chromium_floor_or_a_missing_forbidden_list(self):
        values, _, _ = g.read_floors()
        self.assertNotIn('MIN_CHROMIUM_VERSION', values)
        d = tempfile.mkdtemp()
        floors = os.path.join(d, 'security-floors.env')
        with open(g.FLOORS_ENV, encoding='utf-8') as f, open(floors, 'w', encoding='utf-8') as o:
            o.write(f.read() + 'MIN_CHROMIUM_VERSION=156.0.8078.79-r0\n')
        with mock.patch.object(g, 'FLOORS_ENV', floors):
            rc, _ = run(['--mode', 'pr', '--results', d, 'static'])
        self.assertEqual(rc, 1)
        self.assertTrue(any('MIN_CHROMIUM_VERSION is retired' in f for f in result(d, 'static')['fails']))
        pol = g.policy()
        del pol['roles']['image']['forbidden_apk']
        pol['roles']['image']['floors_checks'] = ['node', 'alpine']
        d = tempfile.mkdtemp()
        with mock.patch.object(g, 'policy', lambda: pol):
            rc, _ = run(['--mode', 'pr', '--results', d, 'static'])
        fails = result(d, 'static')['fails']
        self.assertEqual(rc, 1)
        self.assertTrue(any('image: forbidden_apk must be a non-empty list' in f for f in fails), fails)
        self.assertTrue(any('image: floors_checks must include apk-absent:chromium' in f for f in fails), fails)

    def test_pdf_gate_refuses_a_role_without_pdf_render(self):
        # O1: the one image renders PDFs; a role that does not (none exists today) is refused before anything runs.
        pol = g.policy()
        pol['roles']['nopdf'] = dict(pol['roles']['image'], pdf_render=False)
        d = tempfile.mkdtemp()
        with mock.patch.object(g, 'policy', lambda: pol):
            rc, _ = run(['--mode', 'pr', '--results', d, 'pdf', 'nopdf', 'crewflow-gate/image:none'])
        self.assertEqual(rc, 1)
        self.assertTrue(any('does not render PDFs' in f for f in result(d, 'nopdf-pdf')['fails']))

    def test_pdf_gate_uses_the_worker_jobs_contract(self):
        # O1: no launcher. The render runs as the Worker runs in the production compose: uid 1000, HOME=/nonexistent,
        # TMPDIR and XDG caches on the jobs tmpfs, and the per-instance heartbeat file.
        self.assertEqual((g.WORKER_JOBS_UID, g.WORKER_JOBS_GID), (1000, 1000))
        self.assertEqual(g.WORKER_JOBS_ENV['HOME'], '/nonexistent')
        self.assertTrue(g.WORKER_JOBS_ENV['TMPDIR'].startswith('/tmp/crewflow-jobs'))
        self.assertTrue(all(v.startswith('/tmp/crewflow-jobs') for k, v in g.WORKER_JOBS_ENV.items() if k.startswith('XDG_')))
        self.assertEqual(g.WORKER_JOBS_ENV['CREWFLOW_INSTANCE_HEALTH_FILE'], '/run/crewflow-health/jobs/heartbeat.json')


class Decisions(unittest.TestCase):
    base = {'id': 'CVE-2026-67215', 'packages': ['cjson'], 'images': ['image'], 'decision': 'accepted-risk',
            'owner_decision_ref': 'OWNER-2026-11-10-1', 'decided_by': 'owner', 'decided_on': '2026-11-10',
            'expires': '2027-02-10', 'justification': 'unreachable: librist only'}

    def check(self, entries, today='2026-11-20'):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'decisions.json')
            with open(path, 'w') as f:
                json.dump({'schema': 1, 'decisions': entries}, f)
            c = g.Check('t', 'pr', None)
            with mock.patch.object(g, 'DECISIONS_FILE', path), \
                    mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': today, 'GITHUB_ACTIONS': ''}):
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

    def test_today_override_refused_in_release_mode_and_in_ci(self):
        # review F4: the self-test date override can never move an expiry in a real gate run
        with mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': '2030-01-01', 'GITHUB_ACTIONS': ''}):
            with self.assertRaises(RuntimeError):
                g.today('release')
            self.assertEqual(g.today('pr'), g.dt.date(2030, 1, 1))
        with mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': '2030-01-01', 'GITHUB_ACTIONS': 'true'}):
            with self.assertRaises(RuntimeError):
                g.today('pr')
        d = tempfile.mkdtemp()
        with mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': '2030-01-01', 'GITHUB_ACTIONS': ''}):
            rc, out = run(['--mode', 'release', '--results', d, 'static'])
        self.assertEqual(rc, 1)
        self.assertTrue(any('refused' in m for m in result(d, 'static')['fails']))

    def test_committed_register_is_valid(self):
        c = g.Check('t', 'release', None)
        g.validate_decisions(c)
        self.assertEqual(c.fails, [])

    def test_future_decision_date_fails(self):
        valid, c = self.check([dict(self.base, decided_on='2030-01-01', expires='2030-06-30')])
        self.assertEqual(valid, [])
        self.assertTrue(any('in the future' in m for m in c.fails))


def trivy_doc(vulns):
    return {'Metadata': {'ImageID': 'sha256:x'}, 'Results': [{'Type': 'alpine', 'Vulnerabilities': vulns}]}


def grype_doc(matches):
    return {'matches': matches}


class Vulns(unittest.TestCase):
    def evaluate(self, mode, trivy=(), grype=(), apk=None, decisions=(), watch=None, today='2026-11-20'):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, 'image-trivy-vuln.json'), 'w') as f:
            json.dump(trivy_doc(list(trivy)), f)
        with open(os.path.join(d, 'image-grype.json'), 'w') as f:
            json.dump(grype_doc(list(grype)), f)
        with open(os.path.join(d, 'image-apk.json'), 'w') as f:
            json.dump(apk or {}, f)
        dec = os.path.join(d, 'dec.json')
        with open(dec, 'w') as f:
            json.dump({'schema': 1, 'decisions': list(decisions)}, f)
        wl = os.path.join(d, 'wl.json')
        with open(wl, 'w') as f:
            json.dump({'schema': 1, 'advisories': watch or []}, f)
        with mock.patch.object(g, 'DECISIONS_FILE', dec), mock.patch.object(g, 'WATCHLIST_FILE', wl), \
                mock.patch.dict(os.environ, {'IMAGE_GATE_TODAY': today if mode == 'pr' else '', 'GITHUB_ACTIONS': ''}):
            rc, out = run((['--mode', mode] if mode else []) + ['--results', d, 'vulns', 'image'])
        return rc, result(d, 'image-vulns'), out

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

    @staticmethod
    def decision(cve, pkg, decided_days_ago=10, valid_days=60, kind='accepted-risk'):
        now = g.dt.date.today()
        return {'id': cve, 'packages': [pkg], 'images': ['image'], 'decision': kind, 'owner_decision_ref': 'OWNER-1',
                'decided_by': 'owner', 'decided_on': (now - g.dt.timedelta(days=decided_days_ago)).isoformat(),
                'expires': (now - g.dt.timedelta(days=decided_days_ago) + g.dt.timedelta(days=valid_days)).isoformat(),
                'justification': 'x'}

    def test_owner_decision_covers_one_advisory_and_package_only(self):
        dec = self.decision('CVE-2026-20002', 'glib')
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype], decisions=[dec])
        self.assertEqual((rc, r['status']), (0, 'PASS'))
        other = dict(self.unfixed_grype, artifact={'name': 'glib-dev', 'version': '1', 'type': 'apk'})
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype, other], decisions=[dec])
        self.assertEqual(r['status'], 'FAIL')
        expired = self.decision('CVE-2026-20002', 'glib', decided_days_ago=100, valid_days=90)
        rc, r, _ = self.evaluate('release', grype=[self.unfixed_grype], decisions=[expired])
        self.assertEqual(r['status'], 'FAIL')  # expired decision: finding undecided again + register failure

    def test_fixable_high_fails_even_with_a_valid_decision(self):
        # review F3: a register entry can never clear a finding that has a fixed version
        for kind in ('accepted-risk', 'not-affected', 'false-positive'):
            dec = self.decision('CVE-2026-10001', 'libexpat', kind=kind)
            finding = dict(self.fixable_high, VulnerabilityID='CVE-2026-10001')
            for mode in ('pr', 'release'):
                rc, r, _ = self.evaluate(mode, trivy=[finding], decisions=[dec])
                self.assertEqual((rc, r['status']), (1, 'FAIL'), (kind, mode))
                self.assertTrue(any('1 valid owner risk decision' in m for m in r['infos']), r['infos'])
                self.assertTrue(any('fixable HIGH CVE-2026-10001' in m for m in r['fails']), r['fails'])
                self.assertTrue(any('IGNORED' in m for m in r['infos']), r['infos'])

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

    def test_no_arg_base_is_allowed_any_more(self):
        # O1: the Worker is no longer built FROM the API image, so policy.json allows no ARG-based FROM at all; the former
        # Worker Dockerfile's `FROM ${CREWFLOW_BASE_IMAGE}` is refused wherever it appears (stricter than before).
        self.assertEqual(g.policy()['dockerfiles']['arg_base_images'], {})
        for name in ('packages/rab-docker/rab/Dockerfile', 'packages/rab-docker/rab/Dockerfile.worker-bundle'):
            c = self.pins('ARG CREWFLOW_BASE_IMAGE\nFROM ${CREWFLOW_BASE_IMAGE}\n', name)
            self.assertTrue(c.fails, name)


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
        rc, out = run(['--mode', 'pr', '--results', d, 'vulns', 'image'])  # no scanner output at all
        self.assertEqual(rc, 1)
        self.assertEqual(result(d, 'image-vulns')['status'], 'FAIL')


def minimal_pdf(text: str, truncate: bool = False) -> bytes:
    """A tiny Skia-shaped PDF: one page, a Type0 font drawn with a hex Tj string decoded through a ToUnicode CMap."""
    import zlib
    nl = '\n'
    codes = ''.join(format(i + 1, '04X') for i in range(len(text)))
    pairs = ''.join('<%04X> <%04X>%s' % (i + 1, ord(ch), nl) for i, ch in enumerate(text))
    cmap = f'begincmap{nl}{len(text)} beginbfchar{nl}{pairs}endbfchar{nl}endcmap'
    content = zlib.compress(f'BT /F1 12 Tf <{codes}> Tj ET'.encode())
    tu = zlib.compress(cmap.encode())

    def stream(data: bytes) -> bytes:
        return b'<< /Filter /FlateDecode /Length ' + str(len(data)).encode() + b' >>\nstream\n' + data + b'\nendstream'

    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        stream(content),
        b'<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>',
        stream(tu),
    ]
    out = b'%PDF-1.4\n' + b''.join(str(i + 1).encode() + b' 0 obj\n' + o + b'\nendobj\n' for i, o in enumerate(objs))
    return out if truncate else out + b'trailer << /Root 1 0 R >>\n%%EOF\n'



def pdfkit_shaped_pdf(text: str) -> bytes:
    """A tiny pdfkit-shaped PDF (the native renderer's writer): /Resources and /Font are INDIRECT objects, text is a TJ
    array of lower-case hex glyph ids with kerning, decoded through a ToUnicode bfrange with an array destination."""
    import zlib
    n = len(text)
    dst = ' '.join('<%04x>' % ord(ch) for ch in text)
    cmap = (f'begincmap\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n1 beginbfrange\n'
            f'<0001> <{n:04x}> [{dst}]\nendbfrange\nendcmap')
    tj = ' -26.666667 '.join('<%04x>' % (i + 1) for i in range(n))
    content = zlib.compress(f'BT 1 0 0 1 0 595 Tm /F2 11.25 Tf [{tj}] TJ ET'.encode())
    tu = zlib.compress(cmap.encode())

    def stream(data: bytes) -> bytes:
        return b'<< /Filter /FlateDecode /Length ' + str(len(data)).encode() + b' >>\nstream\n' + data + b'\nendstream'

    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources 5 0 R /UserUnit 1 >>',
        stream(content),
        b'<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI] /Font 6 0 R >>',
        b'<< /F2 7 0 R >>',
        b'<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 8 0 R >>',
        stream(tu),
    ]
    out = b'%PDF-1.3\n' + b''.join(str(i + 1).encode() + b' 0 obj\n' + o + b'\nendobj\n' for i, o in enumerate(objs))
    return out + b'trailer << /Root 1 0 R >>\n%%EOF\n'


class Pdf(unittest.TestCase):
    def test_native_renderer_shape(self):
        # P5: the gate's oracle must read the native renderer's output (indirect /Resources and /Font, TJ arrays).
        info = g.inspect_pdf(pdfkit_shaped_pdf('<img src="http://example.invalid/x.png">'))
        self.assertEqual(info['pages'], 1)
        self.assertEqual(info['text'], '<img src="http://example.invalid/x.png">')

    def test_text_and_pages(self):
        info = g.inspect_pdf(minimal_pdf('H5 <script>'))
        self.assertEqual(info['pages'], 1)
        self.assertEqual(info['text'], 'H5 <script>')

    def test_not_a_pdf_or_truncated(self):
        with self.assertRaises(ValueError):
            g.inspect_pdf(b'<html>not a pdf</html>')
        with self.assertRaises(ValueError):
            g.inspect_pdf(minimal_pdf('x', truncate=True))

    def test_encrypted_pdf_is_refused(self):
        with self.assertRaises(ValueError):
            g.inspect_pdf(b'%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer << /Encrypt 2 0 R >>\n%%EOF\n')


# The same synthetic two-page document from both renderers, shared with rab-worker's PDF oracle tests (provenance in
# packages/rab-worker/src/__tests__/helpers/pdf-inspect.spec.ts). Chromium: inline page /Resources. @react-pdf/renderer
# 4.9.0: INDIRECT /Resources, one BT..ET per glyph run, a WinAnsi standard-14 font, the QR as RGB pixels + /SMask.
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'rab-worker', 'src', '__tests__',
                        'fixtures', 'pdf')
FIXTURE_NEEDLES = ['SYNTHETIC FIXTURE REPORT', 'The <Hostile> & "Quoted" Venue', 'Reference FIXTURE-0001', 'Alex Example',
                   '5h 28m', '£1,234.56', '<script>alert(1)</script>', '<img src="http://example.invalid/x.png">',
                   'Zoë Ł. O’Brien-Ñúñez', 'Fixture Workspace · FIXTURE-0001', 'Page 1 of 2',
                   'Second page: totals 13h 33m · £1,335.55 – end', 'Page 2 of 2']


def fixture(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), 'rb') as f:
        return f.read()


class PdfRenderers(unittest.TestCase):
    def check(self, pdf: bytes):
        info = g.inspect_pdf(pdf)
        self.assertEqual(info['pages'], 2)
        self.assertEqual(len(info['page_texts']), 2)
        for n in FIXTURE_NEEDLES:
            self.assertIn(n, info['text'])
        self.assertNotIn('�', info['text'])
        self.assertIn('Alex Example', info['page_texts'][0])
        self.assertNotIn('Alex Example', info['page_texts'][1])
        self.assertIn('5h 28m', info['page_texts'][0].split('\n'))  # one line, not "5" + "h 28m"
        self.assertNotIn('Alex ExampleS-001', info['text'])  # separate cells are never glued together
        self.assertEqual(info['images'], 2)  # the JPEG and the QR; a soft mask is not an image of its own
        return info

    def test_chromium_skia(self):
        pdf = fixture('chromium-skia.pdf')
        self.assertTrue(re.search(r'/Type\s*/Page\s*/Resources\s*<<', pdf.decode('latin1')))  # inline resources
        self.check(pdf)

    def test_react_pdf(self):
        pdf = fixture('react-pdf-4.9.0.pdf')
        raw = pdf.decode('latin1')
        self.assertTrue(re.search(r'/Resources\s+\d+\s+0\s+R', raw))  # indirect resources
        self.assertTrue(re.search(r'/SMask\s+\d+\s+0\s+R', raw))
        info = self.check(pdf)
        self.assertIn('Standard font: Café £5 – naïve “quotes”', info['page_texts'][1].split('\n'))

    def test_both_renderers_print_the_same_needles_and_the_gate_needles_shape(self):
        c, r = g.inspect_pdf(fixture('chromium-skia.pdf')), g.inspect_pdf(fixture('react-pdf-4.9.0.pdf'))
        self.assertEqual([n in c['text'] for n in FIXTURE_NEEDLES], [n in r['text'] for n in FIXTURE_NEEDLES])
        self.assertEqual((c['pages'], c['images']), (r['pages'], r['images']))

    def test_object_stream_inherited_resources_literal_strings_and_forms(self):
        import zlib

        def stream(d: str, data: bytes) -> bytes:
            z = zlib.compress(data)
            return f'<< {d} /Filter /FlateDecode /Length {len(z)} >>\nstream\n'.encode() + z + b'\nendstream'

        members = [(1, '<< /Type /Catalog /Pages 2 0 R >>'),
                   (2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources 4 0 R >>'),
                   (3, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>'),
                   (5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')]
        head, body = '', ''
        for i, t in members:
            head += f'{i} {len(body)} '
            body += t + '\n'
        content = b"BT /F1 12 Tf 72 700 Td (Hello \\(world\\) caf\\351) Tj 14 TL (Next line) ' ET /X1 Do"
        objs = [(4, b'<< /Font << /F1 5 0 R >> /XObject << /X1 7 0 R >> >>'),
                (6, stream('', content)),
                (7, stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 72 600]',
                           b'BT /F1 10 Tf (Inside a form) Tj ET')),
                (8, stream(f'/Type /ObjStm /N {len(members)} /First {len(head)}', (head + body).encode()))]
        pdf = b'%PDF-1.5\n' + b''.join(f'{i} 0 obj\n'.encode() + o + b'\nendobj\n' for i, o in objs) + \
            b'trailer << /Root 1 0 R >>\n%%EOF\n'
        info = g.inspect_pdf(pdf)
        self.assertEqual(info['pages'], 1)
        self.assertEqual(info['page_texts'], ['Hello (world) café\nNext line\nInside a form'])


if __name__ == '__main__':
    unittest.main()
