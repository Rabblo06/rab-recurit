import type { EnrolmentMaterial } from '../mfaApi';
import { otpauthLabel } from '../mfaApi';
import SetupKeyBox from './SetupKeyBox';

/**
 * The design's "Connect your authenticator" body: the server-rendered QR (a PNG data URL — no QR library and no
 * third-party service ever sees the secret), the issuer and account parsed from the server's otpauth:// URI, and the
 * manual setup key.
 */
export default function ScanBlock({
  material,
}: {
  material: EnrolmentMaterial;
}) {
  const { issuer, account } = otpauthLabel(material.otpauthUri);
  return (
    <>
      <div className="acs-scan-block">
        <div className="acs-qr">
          <img
            src={material.qrDataUrl}
            alt="QR code to add Crewflow to your authenticator app"
            width={116}
            height={116}
          />
        </div>
        <div className="acs-scan-info">
          <strong>{issuer}</strong>
          {account && <span className="acs-muted">{account}</span>}
          <span className="acs-muted">
            Can’t scan? Enter the setup key manually.
          </span>
        </div>
      </div>
      <SetupKeyBox manualKey={material.manualKey} />
    </>
  );
}
