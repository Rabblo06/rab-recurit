"""Self-tests for release_guard.py (independent review F1, F2): candidate origin and release environment / ref.

A fake `gh` (a Python script, GH_CMD) serves canned API answers, so these run without network on every OS.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import release_guard as rg  # noqa: E402

REPO = 'Rabblo06/rab-recurit'
SHA = 'c' * 40

FAKE_GH = r'''
import json, os, sys
answers = json.loads(os.environ['FAKE_GH_ANSWERS'])
path = sys.argv[-1]
if path not in answers:
    sys.stderr.write('HTTP 404: Not Found\n'); sys.exit(1)
a = answers[path]
if a == 'ERROR':
    sys.stderr.write('HTTP 500\n'); sys.exit(1)
print(a if isinstance(a, str) else json.dumps(a))
'''


def good_run(**over):
    run = {'id': 42, 'repository': {'full_name': REPO}, 'head_repository': {'full_name': REPO},
           'path': '.github/workflows/publish-image.yaml', 'event': 'workflow_dispatch', 'head_sha': SHA,
           'head_branch': 'main', 'status': 'completed', 'conclusion': 'success'}
    run.update(over)
    return run


def good_env(**over):
    env = {'name': 'release',
           'protection_rules': [{'type': 'required_reviewers', 'reviewers': [{'type': 'User', 'reviewer': {}}]}],
           'deployment_branch_policy': {'protected_branches': False, 'custom_branch_policies': True}}
    env.update(over)
    return env


POLICIES = {'total_count': 2, 'branch_policies': [{'name': 'main', 'type': 'branch'}, {'name': 'rab/v*', 'type': 'tag'}]}


class Guard(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.fake = os.path.join(d, 'gh.py')
        with open(self.fake, 'w') as f:
            f.write(FAKE_GH)

    def run_guard(self, argv, answers, on_main=True):
        out = io.StringIO()
        env = {'GH_CMD': json.dumps([sys.executable, self.fake]), 'FAKE_GH_ANSWERS': json.dumps(answers)}
        with mock.patch.dict(os.environ, env), mock.patch.object(rg, 'commit_on_main', lambda sha: on_main), \
                contextlib.redirect_stdout(out):
            rc = rg.main(argv)
        return rc, out.getvalue()

    # ------------------------------------------------------------------ F1: candidate origin
    def candidate(self, run, run_id='42'):
        return self.run_guard(['candidate', '--repo', REPO, '--run-id', run_id, '--sha', SHA],
                              {f'repos/{REPO}/actions/runs/{run_id}': run})

    def test_candidate_from_our_successful_dispatch_on_main_is_accepted(self):
        for path in ('.github/workflows/publish-image.yaml', '.github/workflows/image-security-gate.yaml',
                     '.github/workflows/image-security-gate.yaml@refs/heads/main'):
            rc, out = self.candidate(good_run(path=path))
            self.assertEqual(rc, 0, out)
        rc, out = self.candidate(good_run(event='release', head_branch='rab/v1.2.3'))
        self.assertEqual(rc, 0, out)

    def test_forged_run_from_another_workflow_is_refused(self):
        rc, out = self.candidate(good_run(path='.github/workflows/ci-e2e.yaml'))
        self.assertEqual(rc, 1)
        self.assertIn('not the image gate or publish workflow', out)

    def test_wrong_commit_is_refused(self):
        rc, out = self.candidate(good_run(head_sha='d' * 40))
        self.assertEqual(rc, 1)
        self.assertIn('not this commit', out)

    def test_failed_or_unfinished_run_is_refused(self):
        for over in ({'conclusion': 'failure'}, {'conclusion': 'cancelled'}, {'status': 'in_progress', 'conclusion': None}):
            rc, out = self.candidate(good_run(**over))
            self.assertEqual(rc, 1, over)
            self.assertIn('not completed/success', out)

    def test_fork_run_is_refused(self):
        rc, out = self.candidate(good_run(head_repository={'full_name': 'attacker/rab-recurit'}))
        self.assertEqual(rc, 1)
        self.assertIn('fork', out)
        rc, out = self.candidate(good_run(repository={'full_name': 'attacker/rab-recurit'}))
        self.assertEqual(rc, 1)

    def test_pull_request_or_push_run_is_refused(self):
        for ev in ('pull_request', 'push', 'pull_request_target', 'workflow_run'):
            rc, out = self.candidate(good_run(event=ev))
            self.assertEqual(rc, 1, ev)

    def test_branch_other_than_main_or_release_tag_is_refused(self):
        rc, out = self.candidate(good_run(head_branch='feature/x'))
        self.assertEqual(rc, 1)
        rc, out = self.candidate(good_run(event='release', head_branch='v9.9.9'))
        self.assertEqual(rc, 1)

    def test_api_error_or_unknown_run_fails_closed(self):
        rc, out = self.candidate('ERROR')
        self.assertEqual(rc, 1)
        rc, out = self.run_guard(['candidate', '--repo', REPO, '--run-id', '42', '--sha', SHA], {})
        self.assertEqual(rc, 1)
        rc, out = self.candidate('not json')
        self.assertEqual(rc, 1)
        rc, out = self.candidate(good_run(), run_id='42; rm -rf /')
        self.assertEqual(rc, 1)

    # ------------------------------------------------------------------ F2: environment and ref
    def environment(self, env, policies=POLICIES, event='workflow_dispatch', ref='refs/heads/main', on_main=True):
        answers = {f'repos/{REPO}/environments/release': env}
        if policies is not None:
            answers[f'repos/{REPO}/environments/release/deployment-branch-policies'] = policies
        return self.run_guard(['environment', '--repo', REPO, '--event', event, '--ref', ref, '--sha', SHA], answers,
                              on_main=on_main)

    def test_protected_environment_and_main_dispatch_pass(self):
        rc, out = self.environment(good_env())
        self.assertEqual(rc, 0, out)
        rc, out = self.environment(good_env(), event='release', ref='refs/tags/rab/v1.0.0')
        self.assertEqual(rc, 0, out)

    def test_missing_environment_fails(self):
        rc, out = self.run_guard(['environment', '--repo', REPO, '--event', 'workflow_dispatch', '--ref',
                                  'refs/heads/main', '--sha', SHA], {})
        self.assertEqual(rc, 1)

    def test_no_reviewers_fails(self):
        rc, out = self.environment(good_env(protection_rules=[]))
        self.assertEqual(rc, 1)
        self.assertIn('no required reviewers', out)

    def test_no_or_wrong_deployment_branch_policy_fails(self):
        rc, out = self.environment(good_env(deployment_branch_policy=None), policies=None)
        self.assertEqual(rc, 1)
        self.assertIn('no deployment-branch policy', out)
        rc, out = self.environment(good_env(deployment_branch_policy={'protected_branches': True,
                                                                     'custom_branch_policies': False}), policies=None)
        self.assertEqual(rc, 1)
        rc, out = self.environment(good_env(), policies={'branch_policies': [{'name': '*', 'type': 'branch'}]})
        self.assertEqual(rc, 1)
        rc, out = self.environment(good_env(), policies={'branch_policies': [
            {'name': 'main', 'type': 'branch'}, {'name': 'feature/*', 'type': 'branch'}]})
        self.assertEqual(rc, 1)

    def test_dispatch_from_a_feature_branch_fails(self):
        rc, out = self.environment(good_env(), ref='refs/heads/feature/x')
        self.assertEqual(rc, 1)
        self.assertIn('only from refs/heads/main', out)

    def test_release_off_main_or_bad_tag_fails(self):
        rc, out = self.environment(good_env(), event='release', ref='refs/tags/rab/v1.0.0', on_main=False)
        self.assertEqual(rc, 1)
        self.assertIn('not on origin/main', out)
        rc, out = self.environment(good_env(), event='release', ref='refs/tags/v1.0.0')
        self.assertEqual(rc, 1)

    def test_other_events_never_publish(self):
        rc, out = self.environment(good_env(), event='push')
        self.assertEqual(rc, 1)


if __name__ == '__main__':
    unittest.main()
