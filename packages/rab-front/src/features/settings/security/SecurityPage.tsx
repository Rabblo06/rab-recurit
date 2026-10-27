import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { api } from '../../../shared/api';
import { MFA_STATUS_KEY, type MfaStatus } from '../../auth/mfa/mfaApi';
import { Notice } from '../../auth/mfa/ui/primitives';
import CurrentSessionCard, { type SessionRow } from './CurrentSessionCard';
import HowItWorksAside from './HowItWorksAside';
import PasswordCard from './PasswordCard';
import { takeReauthIntent, type ReauthIntent } from './reauthReturn';
import {
  usesPassword,
  type ReauthResult,
} from './two-factor/ConfirmIdentityFields';
import EnrolmentDialog from './two-factor/EnrolmentDialog';
import RegenerateCodesDialog from './two-factor/RegenerateCodesDialog';
import TurnOffDialog from './two-factor/TurnOffDialog';
import TwoFactorCard from './two-factor/TwoFactorCard';
import '../../auth/mfa/ui/account-security.css';
import './security-page.css';

interface Me {
  email?: string;
}

type Dialog = { kind: ReauthIntent; reauth?: ReauthResult } | null;

/**
 * Settings → Security (`/settings/security`, owner decision 2026-10-24: a sidebar page, not the design's tab strip).
 * Two-factor card, Password card, Current session card and the "How it works" aside, from the account-security design;
 * every value is server state (`GET /auth/mfa`, `GET /auth/me`, `GET /profile/sessions`). Each change runs in its
 * dialog and the page is re-read from the server only after the server confirmed it.
 */
export default function SecurityPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const mfa = useQuery({
    queryKey: MFA_STATUS_KEY,
    queryFn: async () => (await api.get<MfaStatus>('/auth/mfa')).data,
  });
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<Me>('/auth/me')).data,
    staleTime: 5 * 60 * 1000,
  });
  const { data: sessions } = useQuery({
    queryKey: ['profile', 'sessions'],
    queryFn: async () =>
      (await api.get<SessionRow[]>('/profile/sessions')).data,
  });

  // Back from a Microsoft re-authentication (forwarded by the Account page): reopen the dialog the user was in.
  useEffect(() => {
    const reauth = searchParams.get('reauth');
    if (reauth !== 'ok' && reauth !== 'failed') return;
    const intent = takeReauthIntent();
    const next = new URLSearchParams(searchParams);
    next.delete('reauth');
    setSearchParams(next, { replace: true });
    if (intent) setDialog({ kind: intent, reauth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: MFA_STATUS_KEY });
  const close = () => setDialog(null);
  const returnFocus = () => headingRef.current;
  const status = mfa.data;

  return (
    <div className="acs acs-security-page">
      <div className="acs-security-grid">
        <div className="acs-stack">
          {mfa.isLoading ? (
            <section className="acs-card acs-security-card" aria-busy="true">
              <p className="acs-muted">Loading two-factor authentication…</p>
            </section>
          ) : mfa.isError || !status ? (
            <section className="acs-card acs-security-card acs-stack">
              <Notice tone="error" live>
                Two-factor status couldn’t be loaded. Check your connection and
                try again.
              </Notice>
              <div>
                <button
                  type="button"
                  className="acs-btn acs-btn--secondary"
                  onClick={() => void mfa.refetch()}
                >
                  Try again
                </button>
              </div>
            </section>
          ) : (
            <TwoFactorCard
              status={status}
              headingRef={headingRef}
              onTurnOn={() => setDialog({ kind: 'enrol' })}
              onRegenerate={() => setDialog({ kind: 'regenerate' })}
              onTurnOff={() => setDialog({ kind: 'disable' })}
            />
          )}
          {status && usesPassword(status) && <PasswordCard email={me?.email} />}
          <CurrentSessionCard sessions={sessions} />
        </div>
        <HowItWorksAside status={status} />
      </div>

      {status && dialog?.kind === 'enrol' && (
        <EnrolmentDialog
          status={status}
          email={me?.email}
          reauthResult={dialog.reauth}
          onEnabled={refresh}
          onClose={close}
          returnFocus={returnFocus}
        />
      )}
      {status && dialog?.kind === 'regenerate' && (
        <RegenerateCodesDialog
          status={status}
          email={me?.email}
          reauthResult={dialog.reauth}
          onRegenerated={refresh}
          onClose={close}
          returnFocus={returnFocus}
        />
      )}
      {status && dialog?.kind === 'disable' && (
        <TurnOffDialog
          status={status}
          reauthResult={dialog.reauth}
          onDisabled={refresh}
          onClose={close}
          returnFocus={returnFocus}
        />
      )}
    </div>
  );
}
