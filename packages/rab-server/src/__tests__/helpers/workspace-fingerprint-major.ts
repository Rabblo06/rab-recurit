import {
  FingerprintMajor,
  resetWorkspaceFingerprintSelectionForTests,
  selectWorkspaceFingerprintMajor,
} from '../../database/typeorm/workspace-schema/v1/expected-fingerprints';

/**
 * The explicit selection a UNIT spec makes before it reads workspace fingerprints (EXPECTED_WORKSPACE_FINGERPRINTS,
 * workspaceFingerprintMajor(), anything that reads them). There is no default major: an unselected read throws
 * WorkspaceFingerprintMajorNotSelectedError, in tests exactly as in production, so a spec names the major it means.
 * Call it at the top of the file when a describe body reads a value while Jest collects the tests, otherwise in a hook.
 * Forgets any earlier selection first (test seam, NODE_ENV=test only), so one spec may exercise several majors in turn.
 *
 * Integration specs do not use this: they select from their real server (selectWorkspaceFingerprintsForServer), so they
 * compare against the values of the PostgreSQL major they actually run on.
 */
export function selectWorkspaceFingerprintMajorForUnitTests(
  major: FingerprintMajor,
): FingerprintMajor {
  resetWorkspaceFingerprintSelectionForTests();
  return selectWorkspaceFingerprintMajor(major);
}
