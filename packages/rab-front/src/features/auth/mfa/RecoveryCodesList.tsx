import { useState } from 'react';
import { IconCopy, IconDownload } from '@tabler/icons-react';

import { downloadRecoveryCodes } from './mfaApi';

/**
 * Shows a freshly generated set of recovery codes ONCE. The server keeps only one-way hashes; once this screen is left
 * the codes cannot be shown again (only regenerated). The user must confirm they saved them before continuing.
 */
export default function RecoveryCodesList({
  codes,
  accountLabel,
  continueLabel = 'Continue',
  onContinue,
}: {
  codes: readonly string[];
  accountLabel?: string;
  continueLabel?: string;
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mfa-recovery">
      <p style={{ fontSize: 13, color: 'var(--font-secondary)', margin: '0 0 12px', lineHeight: '20px' }}>
        Save these recovery codes. Each one signs you in once if you lose your authenticator. They won’t be shown again.
      </p>
      <ol
        aria-label="Recovery codes"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 16px', listStyle: 'none', margin: '0 0 12px', padding: 12, borderRadius: 6, border: '1px solid var(--border-medium)', background: 'var(--bg-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 }}
      >
        {codes.map((code) => (
          <li key={code} style={{ whiteSpace: 'nowrap' }}>{code}</li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button type="button" className="btn btn-outline" onClick={() => void copy()}>
          <IconCopy size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => downloadRecoveryCodes(codes, accountLabel)}>
          <IconDownload size={14} /> Download
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--font-primary)', marginBottom: 14 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I’ve saved these codes somewhere safe
      </label>
      <button type="button" className="btn btn-dark" style={{ width: '100%' }} disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>
    </div>
  );
}
