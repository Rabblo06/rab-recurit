import { useQuery } from '@tanstack/react-query';

import { adminApi } from './adminPanelApi';

const TONE: Record<string, string> = { ok: 'ap-ok', warn: 'ap-warn', bad: 'ap-bad', neutral: '' };

/**
 * Admin panel → Security (mockup v2), read-only. Switch states come from the live environment (`GET /admin/security`);
 * signing keys are key IDs and roles only — never key material. "Tokens verified (24 h)" has no counter yet, so it says
 * "Not measured" and the legacy-key retirement guidance is NOT shown (it would need that counter; never guessed).
 */
export default function SecurityTab() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['admin', 'security'], queryFn: adminApi.security });
  return (
    <>
      <section className="ap-block" aria-label="Security switches">
        <div className="ap-block-head">
          <h2 className="ap-h2">Security switches</h2>
          <p className="ap-sub">Protections already built into Crewflow and whether they are on. Read-only: each is an environment variable.</p>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Protection</th><th>Variable</th><th>State</th><th>Recommended</th></tr></thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={4} className="ap-empty">Loading…</td></tr>
              ) : isError || !data?.switches ? (
                <tr><td colSpan={4} className="ap-empty">Security settings could not be loaded.</td></tr>
              ) : (
                data.switches.map((s) => (
                  <tr key={s.variable}>
                    <td>{s.label}</td>
                    <td className="ap-mono">{s.variable}</td>
                    <td><span className={`ap-pill ${TONE[s.tone] ?? ''}`}>{s.state}</span></td>
                    <td>{s.recommended}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="ap-callout">States are read from this server’s environment right now. Changing one means changing the variable in OpenShip and redeploying.</p>
      </section>

      <section className="ap-block" aria-label="Signing keys">
        <div className="ap-block-head">
          <h2 className="ap-h2">Signing keys</h2>
          <p className="ap-sub">Keys that sign and verify sign-in tokens. Rotate with the <span className="ap-mono">secret:rotate</span> command.</p>
        </div>
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Key ID</th><th>Use</th><th>Derived from</th><th>Status</th><th className="ap-num">Tokens verified (24 h)</th></tr></thead>
            <tbody>
              {!data?.signingKeys ? (
                <tr><td colSpan={5} className="ap-empty">{isLoading ? 'Loading…' : 'Not available.'}</td></tr>
              ) : (
                data.signingKeys.map((k) => (
                  <tr key={k.kid}>
                    <td className="ap-mono">{k.kid}</td>
                    <td>{k.use === 'signs_and_verifies' ? 'Signs and verifies' : 'Verifies only'}</td>
                    <td>{k.derivedFrom}</td>
                    <td>{k.status === 'active' ? <span className="ap-pill ap-ok">Active</span> : <span className="ap-pill ap-warn">Accepted</span>}</td>
                    <td className="ap-num ap-muted">Not measured</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="ap-callout">
          Per-key verification counts are not collected yet, so this page cannot say whether the legacy key is still in use. Do not turn off APP_JWT_LEGACY_VERIFY_ENABLED on the strength of this page alone.
        </p>
        {data?.encryptionKeys && (
          <p className="ap-muted" style={{ margin: 0, font: 'var(--text-small)' }}>
            Encryption keyring: active <span className="ap-mono">{data.encryptionKeys.activeKid}</span> · {data.encryptionKeys.kids.length} key{data.encryptionKeys.kids.length === 1 ? '' : 's'} loaded.
          </p>
        )}
      </section>
    </>
  );
}
