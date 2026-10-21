import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import Drawer from '../../../shared/components/Drawer';
import { getApiErrorMessage } from '../../../shared/lib/apiError';

interface CreatedCeo {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  invitationStatus: 'pending' | 'cancelled' | 'expired' | 'queued' | 'sending' | 'delivery_failed' | null;
}

interface CreatedOrganisation {
  id: string;
  name: string;
  slug: string;
  ceo: CreatedCeo | null;
}

const empty = { name: '', ceoEmail: '', ceoFirstName: '', ceoLastName: '' };

/** Honest, never-fake delivery copy — a queued email is a queued email, not a received one. */
function inviteDeliveryCopy(status: CreatedCeo['invitationStatus']): string {
  if (status === 'queued' || status === 'sending') return 'Invitation queued for delivery. The CEO has not received it yet.';
  if (status === 'delivery_failed') return 'The invitation email could not be queued for delivery. You can resend it from the organisation detail.';
  if (status === 'pending') return 'Invitation created. Delivery status will update shortly.';
  return 'Invitation created.';
}

export default function NewOrganisationDrawer({
  open,
  inline = false,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** The Members Add view reuses the same fields and mutation without opening a drawer. */
  inline?: boolean;
  onClose: () => void;
  /** Fired once, right after a successful create, with the new organisation's id — the caller opens its detail drawer. */
  onCreated: (organisationId: string) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(empty);
  const [created, setCreated] = useState<CreatedOrganisation | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setForm(empty); setCreated(null); setError(''); }
  }, [open]);

  const dirty = !created && (form.name !== '' || form.ceoEmail !== '' || form.ceoFirstName !== '' || form.ceoLastName !== '');

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedOrganisation>('/admin/organisations', {
        name: form.name.trim(),
        ceoEmail: form.ceoEmail.trim(),
        ceoFirstName: form.ceoFirstName.trim(),
        ceoLastName: form.ceoLastName.trim(),
      }),
    onSuccess: ({ data }) => {
      setCreated(data);
      setError('');
      qc.invalidateQueries({ queryKey: ['admin', 'organisations'] });
    },
    onError: (e: unknown) => setError(getApiErrorMessage(e, 'Could not create this organisation.')),
  });

  const canSubmit = form.name.trim().length > 0 && form.ceoEmail.trim().length > 0 && form.ceoFirstName.trim().length > 0 && form.ceoLastName.trim().length > 0;

  function close() {
    onClose();
  }

  function done() {
    if (created) onCreated(created.id);
    close();
  }

  const footer = (
        created ? (
          <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
            <button type="button" className="btn btn-dark" onClick={done}>Done</button>
          </div>
        ) : (
          <div className="modal-actions" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
            {!inline && <button type="button" className="btn btn-outline" onClick={close}>Cancel</button>}
            <button type={inline ? "submit" : "button"} className="btn btn-dark" disabled={!canSubmit || create.isPending} onClick={inline ? undefined : () => { setError(''); create.mutate(); }}>
              {create.isPending ? 'Creating…' : 'Create Organisation & Invite CEO'}
            </button>
          </div>
        )
  );
  const body = (<>
      {created ? (
        <div>
          <p style={{ fontSize: 13, color: 'var(--feedback-success)', margin: '0 0 16px' }}>
            Organisation created.
          </p>
          <div className="settings-row"><span>Organisation</span><span style={{ color: 'var(--font-primary)' }}>{created.name}</span></div>
          <div className="settings-row"><span>Subdomain-safe slug</span><span style={{ color: 'var(--font-primary)' }}>{created.slug}</span></div>
          {created.ceo && (
            <>
              <div className="settings-row"><span>CEO</span><span style={{ color: 'var(--font-primary)' }}>{created.ceo.firstName} {created.ceo.lastName}</span></div>
              <div className="settings-row"><span>CEO email</span><span style={{ color: 'var(--font-primary)' }}>{created.ceo.email}</span></div>
            </>
          )}
          <p style={{ fontSize: 12, color: 'var(--font-tertiary)', margin: '12px 0 0' }}>
            {created.ceo ? inviteDeliveryCopy(created.ceo.invitationStatus) : 'No CEO invitation was created.'}
          </p>
        </div>
      ) : (
        <div className="organisation-create-fields">
          <div className="field">
            <label htmlFor="org-name">Organisation name</label>
            <input required disabled={create.isPending} id="org-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="org-ceo-email">CEO email</label>
            <input required disabled={create.isPending} id="org-ceo-email" type="email" value={form.ceoEmail} onChange={(e) => setForm((f) => ({ ...f, ceoEmail: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="org-ceo-first">CEO first name</label>
            <input required disabled={create.isPending} id="org-ceo-first" value={form.ceoFirstName} onChange={(e) => setForm((f) => ({ ...f, ceoFirstName: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="org-ceo-last">CEO last name</label>
            <input required disabled={create.isPending} id="org-ceo-last" value={form.ceoLastName} onChange={(e) => setForm((f) => ({ ...f, ceoLastName: e.target.value }))} />
          </div>
          {error && <p role="alert" className="error">{error}</p>}
        </div>
      )}
  </>);

  if (inline) return <form className="leadership-onboarding-form" onSubmit={(event) => {
    event.preventDefault();
    if (!created && canSubmit && !create.isPending) { setError(''); create.mutate(); }
  }}>{body}{footer}</form>;

  return <Drawer open={open} onClose={close} dirty={dirty} title="New Organisation"
    description="Creates the organisation and invites its first CEO." footer={footer} loading={create.isPending}>
    {body}
  </Drawer>;
}
