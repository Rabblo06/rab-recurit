import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconCircleCheck, IconMail, IconTrash, IconUserOff } from '@tabler/icons-react';
import { api } from '../../shared/api';
import BulkActionBar, { type BulkAction } from '../../shared/components/BulkActionBar';
import ModalFrame from '../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../shared/lib/apiError';

/** Which roster a selection belongs to. Each kind talks only to its own endpoints — ids never cross kinds. */
export type SelectionKind = 'staff' | 'manager' | 'venueManager';

/** What the list row said about a selected record when it was ticked (display + eligibility preview only). */
export interface SelectedRecord {
  name: string;
  accountStatus: string;
  /** Staff only: activation is the employment status (`/staff/:id/deactivate|reactivate`). */
  employmentStatus?: string | null;
}

export interface BulkPermissions {
  /** Activate / Deactivate / Delete — the same permission the single-record routes check (server re-checks every call). */
  lifecycle: boolean;
  email: boolean;
}

type ActionKey = 'activate' | 'deactivate' | 'delete';
const BASE: Record<SelectionKind, string> = { staff: '/staff', manager: '/managers', venueManager: '/venue-managers' };
const EMAIL_ROLE: Record<SelectionKind, 'staff' | 'manager' | 'venueManager'> = { staff: 'staff', manager: 'manager', venueManager: 'venueManager' };
/** Bounded: one request at a time, never more than this many per run. */
export const MAX_BULK_RECORDS = 100;

const NOT_ACCEPTED = new Set(['invited', 'invite_expired', 'pending']);

/**
 * Client-side PREVIEW of who each action applies to, mirroring the row actions and the server's lifecycle rules
 * (`StaffService.deactivate|reactivate`, `ManagerService.setActive`: an invited / invite-expired account is never
 * activated or deactivated). The server decides every record again; a 409 there is reported, never hidden.
 */
export function eligibility(kind: SelectionKind, action: ActionKey, r: SelectedRecord): { ok: boolean; reason?: string } {
  if (action === 'delete') return { ok: true };
  if (NOT_ACCEPTED.has(r.accountStatus)) return { ok: false, reason: 'invitation not accepted yet' };
  if (kind === 'staff') {
    if (r.accountStatus !== 'active' && r.accountStatus !== 'suspended') return { ok: false, reason: `account is ${r.accountStatus.replace(/_/g, ' ')}` };
    const isActive = r.employmentStatus === 'active';
    if (action === 'activate') return isActive ? { ok: false, reason: 'already active' } : { ok: true };
    return isActive ? { ok: true } : { ok: false, reason: 'already inactive' };
  }
  if (action === 'activate') return r.accountStatus === 'suspended' ? { ok: true } : { ok: false, reason: r.accountStatus === 'active' ? 'already active' : `account is ${r.accountStatus.replace(/_/g, ' ')}` };
  return r.accountStatus === 'active' ? { ok: true } : { ok: false, reason: 'not active' };
}

function serverMessage(e: unknown): string {
  return getApiErrorMessage(e, 'Request failed.');
}

interface Outcome { id: string; name: string; ok: boolean; message?: string }

const LABEL: Record<ActionKey, { verb: string; title: string; done: string }> = {
  activate: { verb: 'Activate', title: 'Activate accounts', done: 'activated' },
  deactivate: { verb: 'Deactivate', title: 'Deactivate accounts', done: 'deactivated' },
  delete: { verb: 'Delete', title: 'Delete accounts', done: 'deleted' },
};

/**
 * The Users page's floating bulk-action bar and its confirmation flow: Activate, Deactivate, Send Email, Delete — each only
 * when the caller holds the matching permission (display hint; the server re-checks every request). Runs the EXISTING
 * single-record endpoints one record at a time (no generic bulk mutation, no unbounded Promise.all), shows exactly which
 * records will be skipped and why before anything runs, then reports per-record success/failure. Succeeded records leave
 * the selection; failed ones stay selected for retry. Delete keeps the routes' step-up (current password).
 */
export default function UsersBulkActions({ kind, selected, setSelected, permissions, scopeNote }: {
  kind: SelectionKind;
  selected: Map<string, SelectedRecord>;
  setSelected: (next: Map<string, SelectedRecord>) => void;
  permissions: BulkPermissions;
  scopeNote?: string;
}) {
  const qc = useQueryClient();
  const [action, setAction] = useState<ActionKey | null>(null);
  const [password, setPassword] = useState('');
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  const entries = useMemo(() => [...selected.entries()].slice(0, MAX_BULK_RECORDS), [selected]);
  const plan = useMemo(() => {
    if (!action) return { eligible: [], skipped: [] as Array<{ id: string; name: string; reason: string }> };
    const eligible: Array<{ id: string; name: string }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];
    for (const [id, r] of entries) {
      const e = eligibility(kind, action, r);
      if (e.ok) eligible.push({ id, name: r.name }); else skipped.push({ id, name: r.name, reason: e.reason ?? 'not eligible' });
    }
    return { eligible, skipped };
  }, [action, entries, kind]);

  const close = () => { if (running) return; setAction(null); setPassword(''); setOutcomes(null); };
  useEffect(() => {
    if (!action) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  async function run() {
    if (!action || running || plan.eligible.length === 0) return;
    if (action === 'delete' && !password) return;
    setRunning(true);
    const results: Outcome[] = [];
    for (const target of plan.eligible) {
      try {
        if (action === 'delete') await api.delete(`${BASE[kind]}/${target.id}`, { data: { currentPassword: password } });
        else await api.post(`${BASE[kind]}/${target.id}/${action === 'activate' ? 'reactivate' : 'deactivate'}`);
        results.push({ ...target, ok: true });
      } catch (e) {
        results.push({ ...target, ok: false, message: serverMessage(e) });
        // A refused step-up (wrong password) fails every remaining record the same way — stop instead of repeating it.
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (action === 'delete' && (status === 401 || status === 403)) {
          for (const rest of plan.eligible.slice(results.length)) results.push({ ...rest, ok: false, message: 'Not attempted.' });
          break;
        }
      }
      setOutcomes([...results]);
    }
    setOutcomes(results);
    setRunning(false);
    setPassword('');
    const next = new Map(selected);
    for (const r of results) if (r.ok) next.delete(r.id);
    setSelected(next);
    const listKey = kind === 'staff' ? 'staff' : kind === 'manager' ? 'managers' : 'venue-managers';
    void qc.invalidateQueries({ queryKey: [listKey] });
    void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
  }

  const openEmail = () => document.dispatchEvent(new CustomEvent('open-bulk-email', {
    detail: { role: EMAIL_ROLE[kind], userIds: [...selected.keys()], names: [...selected.values()].map((r) => r.name) },
  }));

  const actions: BulkAction[] = [];
  if (permissions.lifecycle) {
    actions.push({ key: 'activate', label: 'Activate', icon: <IconCircleCheck size={16} stroke={1.7} />, onClick: () => setAction('activate') });
    actions.push({ key: 'deactivate', label: 'Deactivate', icon: <IconUserOff size={16} stroke={1.7} />, onClick: () => setAction('deactivate') });
  }
  if (permissions.email) actions.push({ key: 'email', label: 'Send Email', icon: <IconMail size={16} stroke={1.7} />, onClick: openEmail });
  if (permissions.lifecycle) actions.push({ key: 'delete', label: 'Delete', icon: <IconTrash size={16} stroke={1.7} />, onClick: () => setAction('delete'), tone: 'danger' });

  const succeeded = outcomes?.filter((o) => o.ok).length ?? 0;
  const failed = outcomes?.filter((o) => !o.ok) ?? [];
  const label = action ? LABEL[action] : null;
  const over = selected.size > MAX_BULK_RECORDS;

  return (
    <>
      <BulkActionBar count={selected.size} onClear={() => setSelected(new Map())} actions={actions} scopeNote={scopeNote} />
      <ModalFrame
        open={!!action}
        onBackdropMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        dialogProps={{ role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'bulk-action-title' }}
        dialogClassName="bulk-action-dialog"
      >
        {label && (
          <>
            <h3 id="bulk-action-title">{label.title}</h3>
            {outcomes && !running ? (
              <>
                <p role="status" className={failed.length ? (succeeded ? 'feedback-warning' : 'feedback-error') : 'feedback-success'}>
                  {succeeded} of {outcomes.length} {label.done}{failed.length ? ` · ${failed.length} failed and stay selected` : ''}.
                </p>
                <ul className="bulk-result-list" aria-label="Results">
                  {outcomes.map((o) => (
                    <li key={o.id} className={o.ok ? 'ok' : 'failed'}><span>{o.name}</span><span>{o.ok ? label.done : o.message}</span></li>
                  ))}
                </ul>
                <div className="modal-actions"><button className="btn btn-dark" onClick={close} autoFocus>Done</button></div>
              </>
            ) : (
              <>
                <p className="bulk-plan">
                  <strong>{plan.eligible.length}</strong> of {entries.length} selected {plan.eligible.length === 1 ? 'is' : 'are'} eligible.
                  {action === 'delete' && ' Deleting cannot be undone; the server still refuses accounts it must keep.'}
                </p>
                {over && <p className="feedback-warning bulk-plan">Only the first {MAX_BULK_RECORDS} selected records are processed in one run.</p>}
                {plan.skipped.length > 0 && (
                  <>
                    <p className="bulk-plan-sub">{plan.skipped.length} will be skipped:</p>
                    <ul className="bulk-result-list" aria-label="Skipped records">
                      {plan.skipped.map((s) => <li key={s.id} className="skipped"><span>{s.name}</span><span>{s.reason}</span></li>)}
                    </ul>
                  </>
                )}
                {running && outcomes && <p role="status" className="bulk-plan-sub">Working… {outcomes.length} of {plan.eligible.length}</p>}
                {action === 'delete' && (
                  <div className="field" style={{ marginTop: 14 }}>
                    <label htmlFor="bulk-step-up">Your current password</label>
                    <input id="bulk-step-up" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={running} autoFocus />
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn btn-outline" onClick={close} disabled={running}>Cancel</button>
                  <button
                    className={`btn btn-dark${action === 'delete' ? ' btn-destructive' : ''}`}
                    onClick={() => void run()}
                    disabled={running || plan.eligible.length === 0 || (action === 'delete' && !password)}
                  >
                    {running ? 'Working…' : `${label.verb} ${plan.eligible.length}`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </ModalFrame>
    </>
  );
}
