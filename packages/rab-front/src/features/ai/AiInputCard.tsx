import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconHelpCircle, IconListDetails } from '@tabler/icons-react';
import type { AiInputAnswerRequest, AiInputRequestView } from '@rab/shared';

import { getApiErrorCode } from '../../shared/lib/apiError';
import { isSilentError } from '../../shared/lib/mutationFeedback';
import { aiKeys } from './aiApi';
import { AI_CARD_ERROR_TEXT, aiCardKeys, aiCardsApi } from './aiCardsApi';
import { useAiChat } from './AiChatProvider';

const STATE_TEXT: Record<AiInputRequestView['state'], string> = {
  awaiting_input: 'Waiting for your answer',
  answered: 'Answered',
  superseded: 'Replaced by a newer question',
  expired: 'Expired',
};

type FormField = NonNullable<AiInputRequestView['form']>['fields'][number];

/** Validates one form value against the field the server asked for; returns the typed value or an error text. */
export function validateFormValue(field: FormField, raw: string, maxChars: number): { value: string | number | null } | { error: string } {
  const text = raw.trim();
  if (!text) return field.required ? { error: 'Required.' } : { value: null };
  if (field.type === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? { value: n } : { error: 'Enter a number.' };
  }
  if (field.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? { value: text } : { error: 'Enter a date.' };
  if (field.type === 'select') return field.options?.includes(text) ? { value: text } : { error: 'Choose one of the options.' };
  return text.length > maxChars ? { error: `At most ${maxChars.toLocaleString('en-GB')} characters.` } : { value: text };
}

/**
 * U5 question / form card (owner chat mockup "5 Question", Phase 5c): the assistant paused the turn
 * (`waiting_for_input`) to ask something. A question offers the server's options and, when allowed, a length-bounded
 * free-text answer; a form validates every field against the schema it asked for (required, number, date, one of the
 * options) and sends ONLY those keys. The answer is the person's input (the server applies the input cap, masking and the
 * outgoing-payload scan) and continues the conversation as a new turn. Answered, replaced and expired cards are read-only.
 */
export default function AiInputCard({ request, conversationId, maxChars }: { request: AiInputRequestView; conversationId: string; maxChars: number }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const titleId = useId();
  const [text, setText] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const open = request.state === 'awaiting_input' && Date.parse(request.expiresAt) > Date.parse(request.serverNow) && !sent;

  const send = async (answer: AiInputAnswerRequest['answer']) => {
    if (!open || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await aiCardsApi.answer(conversationId, request.requestId, answer);
      setSent('Answer sent.');
      if (result?.request) qc.setQueryData<AiInputRequestView[]>(aiCardKeys.inputs(scope, conversationId), (prev) => prev?.map((r) => (r.requestId === result.request.requestId ? result.request : r)) ?? prev);
      void qc.invalidateQueries({ queryKey: aiCardKeys.inputs(scope, conversationId) });
      // The continuation turn (S7 `continuationTurnId`) appears in the re-read transcript and is followed from there.
      void qc.invalidateQueries({ queryKey: aiKeys.detail(scope, conversationId) });
    } catch (err) {
      if (isSilentError(err)) return;
      const code = getApiErrorCode(err);
      setError((code && AI_CARD_ERROR_TEXT[code]) || 'Your answer could not be sent. Try again.');
      if (code === 'AI_INPUT_INVALID') {
        // `issues` are paths only (e.g. "answer.places"): mark those fields.
        const issues = (err as { response?: { data?: { issues?: unknown } } })?.response?.data?.issues;
        if (Array.isArray(issues)) setFieldErrors(Object.fromEntries(issues.filter((i): i is string => typeof i === 'string').map((i) => [i.replace(/^answer\.?/, ''), 'Check this answer.']).filter(([k]) => k)));
      }
      if (code === 'AI_INPUT_NOT_PENDING' || code === 'AI_INPUT_EXPIRED') void qc.invalidateQueries({ queryKey: aiCardKeys.inputs(scope, conversationId) });
    } finally {
      setBusy(false);
    }
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    if (!request.form) return;
    const answer: Record<string, string | number | null> = {};
    const errors: Record<string, string> = {};
    for (const field of request.form.fields) {
      const r = validateFormValue(field, values[field.key] ?? '', maxChars);
      if ('error' in r) errors[field.key] = r.error;
      else answer[field.key] = r.value;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    void send(answer);
  };
  const freeText = text.trim();

  return (
    <section className="ai-dcard ai-input-card" data-state={sent ? 'answered' : request.state} aria-labelledby={titleId}>
      <div className="ai-dcard-head">
        {request.inputKind === 'form' ? <IconListDetails size={14} aria-hidden="true" /> : <IconHelpCircle size={14} aria-hidden="true" />}
        <h4 id={titleId}>{request.inputKind === 'form' ? request.form?.title ?? 'A few details' : 'A question for you'}</h4>
        <span className="ai-dcard-pill" data-tone={open ? 'warn' : 'muted'}>{sent ? 'Answered' : STATE_TEXT[request.state]}</span>
      </div>
      <div className="ai-dcard-body">
        {request.question && (
          <>
            <p className="ai-dcard-summary">{request.question.text}</p>
            {open && (
              <div className="ai-input-options" role="group" aria-label="Answers">
                {request.question.options.map((option) => (
                  <button key={option} type="button" className="ai-input-option" disabled={busy} onClick={() => void send(option)}>{option}</button>
                ))}
              </div>
            )}
            {open && request.question.allowFreeText && (
              <form className="ai-input-free" onSubmit={(e) => { e.preventDefault(); if (freeText) void send(freeText); }}>
                <label htmlFor={`${titleId}-free`} className="visually-hidden">Your own answer</label>
                <input id={`${titleId}-free`} type="text" placeholder="Or type your own answer…" maxLength={maxChars} value={text} onChange={(e) => setText(e.target.value)} />
                <button type="submit" className="btn btn-dark btn-sm" disabled={!freeText || busy}>Send</button>
              </form>
            )}
          </>
        )}
        {request.form && (
          <form className="ai-input-form" onSubmit={submitForm} noValidate>
            {request.form.fields.map((field) => {
              const id = `${titleId}-${field.key}`;
              const err = fieldErrors[field.key];
              return (
                <div key={field.key} className="ai-input-field">
                  <label htmlFor={id}>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</label>
                  {field.type === 'select' ? (
                    <select id={id} value={values[field.key] ?? ''} disabled={!open} required={field.required} aria-invalid={!!err || undefined} aria-describedby={err ? `${id}-err` : undefined} onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}>
                      <option value="">Choose…</option>
                      {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      id={id}
                      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                      maxLength={field.type === 'text' ? maxChars : undefined}
                      value={values[field.key] ?? ''}
                      disabled={!open}
                      required={field.required}
                      aria-invalid={!!err || undefined}
                      aria-describedby={err ? `${id}-err` : undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                  )}
                  {err && <span id={`${id}-err`} className="ai-dcard-field-error">{err}</span>}
                </div>
              );
            })}
            {open && <div className="ai-dcard-foot"><button type="submit" className="btn btn-dark btn-sm" disabled={busy}>{busy ? 'Sending…' : 'Send answers'}</button></div>}
          </form>
        )}
        {error && <p className="ai-dcard-error" role="alert">{error}</p>}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{`Question status: ${sent ?? STATE_TEXT[request.state]}`}</p>
    </section>
  );
}
