import { useState } from 'react';

import type { EnrolmentMaterial } from './mfaApi';

/**
 * The provisioning material, shown once: a QR code rendered by the SERVER (a PNG data URL — no third-party QR service
 * ever sees the secret) and the same key for manual entry. Nothing is stored in the browser.
 */
export default function EnrolmentQr({ material }: { material: EnrolmentMaterial }) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
      <img src={material.qrDataUrl} alt="QR code to add Crewflow to your authenticator app" width={180} height={180} style={{ borderRadius: 6, border: '1px solid var(--border-light)', background: '#fff' }} />
      {showKey ? (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 12, color: 'var(--font-secondary)', margin: '0 0 4px' }}>Enter this key in your authenticator app (time-based):</p>
          <code aria-label="Setup key" style={{ fontSize: 13, letterSpacing: 1, userSelect: 'all', wordBreak: 'break-all' }}>{material.manualKey}</code>
        </div>
      ) : (
        <button type="button" className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowKey(true)}>
          Can’t scan it? Enter a setup key instead
        </button>
      )}
    </div>
  );
}
