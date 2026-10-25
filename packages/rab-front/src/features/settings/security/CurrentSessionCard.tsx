import { describeDevice } from '../profile/device-label';
import { AcsIcon } from '../../auth/mfa/ui/icons';
import { StatusBadge } from '../../auth/mfa/ui/primitives';

export interface SessionRow {
  familyId: string;
  userAgent: string | null;
  isCurrentDevice: boolean;
}

/**
 * The design's "Current session" card: the `GET /profile/sessions` row the server marks `isCurrentDevice`, labelled from
 * its User-Agent (`describeDevice`, shared with Profile → Devices). Device and browser only — there is no IP geolocation
 * anywhere (UI_PLAN §2), so no location. Hidden when the server returns no current row.
 */
export default function CurrentSessionCard({
  sessions,
}: {
  sessions: readonly SessionRow[] | undefined;
}) {
  const current = sessions?.find((s) => s.isCurrentDevice);
  if (!current) return null;
  const device = describeDevice(current.userAgent);
  return (
    <section className="acs-card" aria-labelledby="acs-session-title">
      <div className="acs-row acs-row--between acs-card-head">
        <h3 id="acs-session-title" className="acs-card-subtitle">
          Current session
        </h3>
        <StatusBadge on dot={false}>
          This device
        </StatusBadge>
      </div>
      <div className="acs-session-row">
        <div className="acs-device-box" aria-hidden="true">
          <AcsIcon name={device.kind === 'desktop' ? 'desktop' : 'phone'} />
        </div>
        <div>
          <strong className="acs-small">{device.label}</strong>
          <p className="acs-muted acs-small">Active now</p>
        </div>
      </div>
    </section>
  );
}
