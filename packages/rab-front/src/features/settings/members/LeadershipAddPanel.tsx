import { useState, type ReactNode } from 'react';
import NewOrganisationDrawer from '../admin-panel/NewOrganisationDrawer';
import InitialManagerPage from '../workspace/InitialManagerPage';
import type { LeadershipCapabilities } from './leadershipCapabilities';

/**
 * Compact presentation of the established leadership onboarding forms, gated by explicit server capabilities. Organisation
 * isolation (2026-10-15): Initial Manager onboarding is always the caller's OWN organisation — there is no organisation
 * selector, and nothing here can name another organisation. Creating an organisation (with its CEO) stays a separate,
 * platform-only workflow.
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
  const selected = choices.find((choice) => choice.value === selection)?.value ?? choices[0]?.value;
  const [formVersion, setFormVersion] = useState(0);
  if (!choices.length) return null;

  return <section className="member-invite-card leadership-add" aria-labelledby="add-heading">
    <div className="member-section-heading">
      <h3 id="add-heading">Add organisation leadership</h3>
      <p>{selected === 'ceo' ? 'Create an organisation and invite its CEO.' : 'Invite your organisation\u2019s Initial Manager to set up their workspace.'}</p>
    </div>
    <div className="leadership-controls">
      {modeSelect}
      <div className="field">
        <label htmlFor="leadership-role">Leadership role</label>
        <select id="leadership-role" value={selected} onChange={(event) => setSelection(event.target.value)}>
          {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </div>
    </div>
    {selected === 'ceo'
      ? <NewOrganisationDrawer key={formVersion} inline open onClose={() => undefined} onCreated={() => setFormVersion((version) => version + 1)} />
      : <InitialManagerPage />}
  </section>;
}
