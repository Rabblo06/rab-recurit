import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconClock, IconPencil, IconX } from '@tabler/icons-react';
import { AI_PROPOSAL_LIMITS } from '@rab/shared';

import { getApiErrorCode } from '../../shared/lib/apiError';
import { isSilentError } from '../../shared/lib/mutationFeedback';
import { aiKeys } from './aiApi';
import { AI_CARD_ERROR_TEXT, AI_PROPOSAL_FAILURE_TEXT, AI_WRITE_TOOL_TITLE, aiCardKeys, aiCardsApi, type AiProposal, type AiProposalField } from './aiCardsApi';
import { useAiChat } from './AiChatProvider';
import AiRecordChip from './AiRecordChip';
import { isApplePlatform } from './aiShortcut';

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Needs your approval',
  APPROVED: 'Approved',
  EXECUTED: 'Done',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  FAILED: 'Not applied',
};

/** `datetime` values travel as ISO strings; the input shows local time (`datetime-local`). */
function toLocalInput(iso: string | number | null): string {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const DATETIME_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function display(field: AiProposalField, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'datetime' && typeof value === 'string' && !Number.isNaN(Date.parse(value))) return DATETIME_FORMAT.format(new Date(value));
  return typeof value === 'number' ? value.toLocaleString('en-GB') : value;
}
/** S6: datetimes are ISO UTC strings — the same INSTANT is the same value, whatever the string form. */
function sameValue(field: AiProposalField, a: string | number | null, b: string | number | null): boolean {
  if (field.type === 'datetime' && typeof a === 'string' && typeof b === 'string') {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  }
  return a === b;
}
const asInput = (field: AiProposalField) => (field.type === 'datetime' ? toLocalInput(field.value) : field.value === null ? '' : String(field.value));

/** Parses one edited input back to the server's type; `undefined` = invalid. */
function parseEdit(field: AiProposalField, raw: string): string | number | null | undefined {
  if (field.type === 'integer') {
    if (raw.trim() === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) return undefined;
    return n;
  }
  if (field.type === 'datetime') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  if (field.maxLength !== undefined && raw.length > field.maxLength) return undefined;
  return raw;
}

/**
 * U5 approval card (owner chat mockup "4 Approval", Phase 5): the server's summary, target and fields; ONLY the fields the
 * server marked editable can change and ONLY the changed ones are sent. Approve (⌘↵ on macOS, Ctrl+↵ elsewhere) runs the
 * STORED arguments as this person after the server re-checks access, permission, state and the record itself; a
 * high-impact change asks for a reason and the server's "Confirm it's you" (STEP_UP_REQUIRED, replayed once by the shared
 * client). Reject always needs a reason. Expired or decided cards are read-only. The countdown uses the server clock.
 */
export default function AiApprovalCard({ proposal, receivedAt, assistantName }: { proposal: AiProposal; receivedAt: number; assistantName: string }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(proposal.fields.filter((f) => f.editable).map((f) => [f.key, asInput(f)])));
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<{ text: string; fields: string[] } | null>(null);
  const [announce, setAnnounce] = useState('');
  // Server clock: expiresAt − serverNow at the moment the view arrived, minus the time since (never the client clock alone).
  const [now, setNow] = useState(() => Date.now());
  const remainingMs = Date.parse(proposal.expiresAt) - Date.parse(proposal.serverNow) - (now - receivedAt);
  const pending = proposal.status === 'PENDING';
  const expired = proposal.status === 'EXPIRED' || (pending && remainingMs <= 0);
  const open = pending && !expired;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (pending && expired) void qc.invalidateQueries({ queryKey: aiCardKeys.proposals(scope, proposal.conversationId) });
  }, [expired, pending, proposal.conversationId, qc, scope]);
  // One polite announcement per state change (the error itself is a role=alert line, never announced twice).
  useEffect(() => setAnnounce(`Suggestion status: ${STATUS_TEXT[proposal.status] ?? proposal.status}`), [proposal.status]);

  const edits = useMemo(() => {
    const out: Record<string, string | number | null> = {};
    const invalid: string[] = [];
    for (const f of proposal.fields) {
      if (!f.editable) continue;
      const raw = values[f.key] ?? '';
      if (raw === asInput(f)) continue; // unchanged: never sent
      const parsed = parseEdit(f, raw);
      if (parsed === undefined) invalid.push(f.key);
      else out[f.key] = parsed;
    }
    return { out, invalid };
  }, [proposal.fields, values]);
  const reasonOk = !proposal.requiresReason || (reason.trim().length >= AI_PROPOSAL_LIMITS.reasonMinChars && reason.trim().length <= AI_PROPOSAL_LIMITS.reasonMaxChars);
  const canApprove = open && !busy && edits.invalid.length === 0 && reasonOk;
  const rejectOk = rejectReason.trim().length >= AI_PROPOSAL_LIMITS.reasonMinChars && rejectReason.trim().length <= AI_PROPOSAL_LIMITS.reasonMaxChars;

  const settle = (next: AiProposal) => {
    qc.setQueryData<AiProposal[]>(aiCardKeys.proposals(scope, proposal.conversationId), (prev) => prev?.map((p) => (p.id === next.id ? next : p)) ?? prev);
    void qc.invalidateQueries({ queryKey: aiCardKeys.proposals(scope, proposal.conversationId) });
    // A continuation turn (if the server started one) appears in the transcript and is followed from there.
    void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, proposal.conversationId) });
  };
  const fail = (err: unknown) => {
    if (isSilentError(err)) return;
    const code = getApiErrorCode(err);
    const issues = ((err as { response?: { data?: { issues?: unknown } } })?.response?.data?.issues ?? []) as unknown[];
    const fields = Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string').map((i) => i.replace(/^edits\./, '')) : [];
    const text = code === 'STEP_UP_REQUIRED' || code === 'STEP_UP_MFA_REQUIRED'
      ? 'Not approved: your identity was not confirmed.'
      : (code && AI_CARD_ERROR_TEXT[code]) || 'The decision could not be sent. Nothing was changed. Try again.';
    setError({ text, fields });
    if (code === 'AI_PROPOSAL_STALE' || code === 'AI_PROPOSAL_EXPIRED' || code === 'AI_PROPOSAL_NOT_PENDING') void qc.invalidateQueries({ queryKey: aiCardKeys.proposals(scope, proposal.conversationId) });
  };
  const approve = async () => {
    if (!canApprove) return;
    setBusy('approve');
    setError(null);
    try {
      const result = await aiCardsApi.approve(proposal.id, edits.out, proposal.requiresReason ? reason.trim() : undefined);
      settle(result.proposal);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    if (!open || !rejectOk || busy) return;
    setBusy('reject');
    setError(null);
    try {
      const result = await aiCardsApi.reject(proposal.id, rejectReason.trim());
      setRejecting(false);
      settle(result.proposal);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const apple = isApplePlatform();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (apple ? event.metaKey : event.ctrlKey) && !rejecting) {
      event.preventDefault();
      void approve();
    }
  };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const target = proposal.target;

  return (
    <section className="ai-dcard" data-status={expired && pending ? 'EXPIRED' : proposal.status} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="ai-dcard-head">
        <IconPencil size={14} aria-hidden="true" />
        <h4 id={titleId}>{AI_WRITE_TOOL_TITLE[proposal.tool] ?? 'Suggested change'}</h4>
        <span className="ai-dcard-pill" data-tone={open ? 'warn' : proposal.status === 'EXECUTED' ? 'ok' : 'muted'}>{expired ? 'Expired' : STATUS_TEXT[proposal.status] ?? proposal.status}</span>
      </div>
      <div className="ai-dcard-body">
        <p className="ai-dcard-summary">{proposal.summary}</p>
        {target && (
          <p className="ai-dcard-target">
            {target.type === 'shift' || target.type === 'venue' ? <AiRecordChip recordRef={{ type: target.type, id: target.id }} /> : <span className="ai-record-chip">{target.label ?? 'Staff member'}</span>}
          </p>
        )}
        {proposal.fields.length > 0 && (
          <dl className="ai-dcard-fields">
            {proposal.fields.map((f) => {
              const id = `${titleId}-${f.key}`;
              const invalid = edits.invalid.includes(f.key) || error?.fields.includes(f.key);
              const hasDiff = f.previousValue !== undefined && !sameValue(f, f.previousValue, f.value);
              return (
                <div key={f.key}>
                  <dt>{f.editable && open ? <label htmlFor={id}>{f.label}</label> : f.label}</dt>
                  <dd>
                    {hasDiff && <del className="ai-dcard-old" aria-label={`Was ${display(f, f.previousValue)}`}>{display(f, f.previousValue)}</del>}
                    {f.editable && open ? (
                      f.type === 'multiline' ? (
                        <textarea id={id} rows={3} value={values[f.key] ?? ''} maxLength={f.maxLength} aria-invalid={invalid || undefined} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                      ) : (
                        <input
                          id={id}
                          type={f.type === 'integer' ? 'number' : f.type === 'datetime' ? 'datetime-local' : 'text'}
                          step={f.type === 'integer' ? 1 : undefined}
                          min={f.min}
                          max={f.max}
                          maxLength={f.maxLength}
                          value={values[f.key] ?? ''}
                          aria-invalid={invalid || undefined}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        />
                      )
                    ) : (
                      <span>{display(f, f.value)}</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {open && (
          <p className="ai-dcard-note">
            Runs as you, with your permissions. You can only change the fields shown.
            {proposal.requiresStepUp ? ` It affects ${proposal.affectedCount.toLocaleString('en-GB')} people, so approving needs a reason and you’ll be asked to confirm it’s you.` : ''}
          </p>
        )}
        {open && proposal.requiresReason && (
          <div className="ai-dcard-reason">
            <label htmlFor={`${titleId}-reason`}>Reason (saved to the audit log)</label>
            <textarea id={`${titleId}-reason`} rows={2} value={reason} maxLength={AI_PROPOSAL_LIMITS.reasonMaxChars} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {proposal.status === 'FAILED' && <p className="ai-dcard-note" role="note">{AI_PROPOSAL_FAILURE_TEXT[proposal.failureCode ?? 'internal'] ?? AI_PROPOSAL_FAILURE_TEXT.internal}</p>}
        {proposal.status === 'EXECUTED' && proposal.result && (
          <p className="ai-dcard-note"><IconCheck size={13} aria-hidden="true" /> Applied.{' '}
            {proposal.result.entityType === 'shift' ? <AiRecordChip recordRef={{ type: 'shift', id: proposal.result.entityId }} /> : null}
          </p>
        )}
        {expired && <p className="ai-dcard-note" role="note">{AI_CARD_ERROR_TEXT.AI_PROPOSAL_EXPIRED}</p>}
        {error && <p className="ai-dcard-error" role="alert">{error.text}</p>}
      </div>
      {open && !rejecting && (
        <div className="ai-dcard-foot">
          <span className="ai-dcard-timer"><IconClock size={12} aria-hidden="true" />{`Expires in ${minutes} min`}</span>
          <button type="button" className="btn btn-outline btn-sm ai-dcard-reject" onClick={() => setRejecting(true)} disabled={!!busy}>Reject</button>
          <button type="button" className="btn btn-dark btn-sm" onClick={() => void approve()} disabled={!canApprove} aria-keyshortcuts={apple ? 'Meta+Enter' : 'Control+Enter'}>
            {busy === 'approve' ? 'Approving…' : 'Approve'} <kbd className="ai-kbd" aria-hidden="true">{apple ? '⌘↵' : 'Ctrl+↵'}</kbd>
          </button>
        </div>
      )}
      {open && rejecting && (
        <div className="ai-dcard-rejectbox">
          <label htmlFor={`${titleId}-why`}>{`Tell ${assistantName} why`}</label>
          <textarea
            id={`${titleId}-why`}
            rows={2}
            autoFocus
            value={rejectReason}
            maxLength={AI_PROPOSAL_LIMITS.reasonMaxChars}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setRejecting(false);
              }
            }}
          />
          <div className="ai-dcard-foot">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setRejecting(false)}><IconX size={12} aria-hidden="true" />Cancel</button>
            <button type="button" className="btn btn-dark btn-sm" onClick={() => void reject()} disabled={!rejectOk || !!busy}>{busy === 'reject' ? 'Sending…' : 'Reject'}</button>
          </div>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>
    </section>
  );
}
