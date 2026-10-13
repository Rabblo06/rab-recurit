import { useState } from 'react';

export interface InitialManagerFormValues {
  email: string;
  firstName: string;
  lastName: string;
}

const empty: InitialManagerFormValues = { email: '', firstName: '', lastName: '' };

/**
 * The shared email/name fields for the Initial Manager invite AND replace flows — used by both
 * `InitialManagerPage.tsx` (CEO) and `OrganisationDetailDrawer.tsx` (Super Admin), each of which
 * has two call sites of its own (invite + replace).
 *
 * Gap-review finding (universal self-service onboarding checkpoint, docs/HANDOFF.md): this used
 * to also collect workspace name/subdomain here, submitted by the INVITER. Reversed — the
 * recipient now chooses their own workspace after activating, through the same
 * `CreateWorkspaceScreen` every other Manager already uses. The subdomain-availability-check UI
 * that lived here moved with it; this component is now just the person's identity.
 *
 * Fully self-contained (owns its own field state) — the caller only supplies what differs: the
 * submit action, its label/pending state, and any server error to display.
 */
export default function InitialManagerFormFields({
  idPrefix,
  onSubmit,
  submitting,
  submitLabel,
  error,
}: {
  idPrefix: string;
  onSubmit: (values: InitialManagerFormValues) => void;
  submitting: boolean;
  submitLabel: string;
  error?: string;
}) {
  const [form, setForm] = useState<InitialManagerFormValues>(empty);

  const canSubmit = form.email.trim().length > 0 && form.firstName.trim().length > 0 && form.lastName.trim().length > 0 && !submitting;

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-email`}>Email</label>
        <input id={`${idPrefix}-email`} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoFocus />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-first`}>First name</label>
        <input id={`${idPrefix}-first`} value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-last`}>Last name</label>
        <input id={`${idPrefix}-last`} value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="modal-actions" style={{ marginTop: 16, borderTop: 'none', paddingTop: 0, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-dark" disabled={!canSubmit} onClick={() => onSubmit(form)}>
          {submitting ? `${submitLabel}…` : submitLabel}
        </button>
      </div>
    </>
  );
}
