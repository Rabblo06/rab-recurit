import StaffSelect from '../../users/StaffSelect';
import { useState, type ReactNode } from 'react';
import InitialManagerPage from '../workspace/InitialManagerPage';
import CeoInvitationPanel from './CeoInvitationPanel';
import type { LeadershipCapabilities } from './leadershipCapabilities';

/**
 * Compact presentation of the established leadership onboarding forms, gated by explicit server capabilities. Organisation
 * isolation (2026-10-15): Initial Manager onboarding is always the caller's OWN organisation — there is no organisation
 * selector, and nothing here can name another organisation.
 *
 * Owner correction 2026-10-23: a new organisation starts HERE and only here — a platform administrator's email-only CEO
 * invitation (`CeoInvitationPanel`); the CEO supplies their own name and organisation name when accepting. With a single
 * permitted choice the role is shown fixed, not as a selector.
 */
export default function LeadershipAddPanel({ capabilities, modeSelect }: {
  capabilities: LeadershipCapabilities;
  modeSelect?: ReactNode;
}) {
  const choices = [
    ...(capabilities.canCreateOrganisation ? [{ value: 'ceo', label: 'CEO (Organisation)' }] : []),
    ...(capabilities.initialManagerScope === 'own' ? [{ value: 'initial-manager', label: 'Initial Manager' }] : []),
  ];
  const [selection, setSelection] = useState('');
  const [email, setEmail] = useState('');
  const selected = choices.find((choice) => choice.value === selection)?.value ?? choices[0]?.value;
  if (!choices.length) return null;

  const roleControl = choices.length > 1 ? (
    <div className="field">
      <label htmlFor="leadership-role">Leadership role</label>
      <StaffSelect id="leadership-role" label="Leadership role" value={selected ?? ''} onChange={setSelection}
        options={choices} placeholder="Select role" searchable={false} compact />
    </div>
  ) : (
    <div className="field">
      <label htmlFor="leadership-role">Leadership role</label>
      <input id="leadership-role" value={choices[0]!.label} readOnly aria-readonly="true" />
    </div>
  );

  if (selected === 'ceo') {
    return <section className="leadership-add" aria-label="Add organisation leadership">
      <CeoInvitationPanel roleControl={roleControl} modeSelect={modeSelect} draftEmail={email} onDraftEmailChange={setEmail} />
    </section>;
  }

  return <section className="leadership-add" aria-label="Add organisation leadership">
    {modeSelect}
    <InitialManagerPage roleControl={roleControl} draftEmail={email} onDraftEmailChange={setEmail} />
  </section>;
}
