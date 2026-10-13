import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { IconCheck, IconChevronRight, IconCircle, IconCopy, IconExclamationMark, IconSparkles, IconSquare, IconX } from '@tabler/icons-react';

/** Presentational contracts only: caller-supplied data and callbacks, never fabricated tool work. */
export function ChatActivity({ title, status, children }: { title: string; status: 'queued' | 'running' | 'complete' | 'error'; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const reduce = useReducedMotion();
  const Icon = status === 'complete' ? IconCheck : status === 'error' ? IconExclamationMark : IconCircle;
  return <section className="ai-card" data-status={status}>
    <button className="ai-card-toggle" disabled={!children} aria-expanded={children ? open : undefined} aria-controls={children ? id : undefined} onClick={() => setOpen(value => !value)}><Icon size={15}/><span>{title}</span><span className="sr-only">{status}</span>{children && <IconChevronRight size={14}/>}</button>
    <AnimatePresence initial={false}>{open && <motion.div id={id} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduce ? 0 : .18 }} style={{ overflow: 'hidden' }}><div className="ai-card-detail">{children}</div></motion.div>}</AnimatePresence>
  </section>;
}

export function ChatPlan({ title, steps }: { title: string; steps: { id: string; label: string; done: boolean }[] }) {
  return <section className="ai-card"><strong>{title}</strong><ul className="ai-plan">{steps.map(step => <li key={step.id} data-done={step.done}>{step.done ? <IconCheck size={14}/> : <IconSquare size={14}/>}<span>{step.label}</span><span className="sr-only">{step.done ? 'Complete' : 'Pending'}</span></li>)}</ul></section>;
}

export function ChatMessage({ role, text, time, source, updatedAt, streaming = false, feedback, onFeedback }: {
  role: 'user' | 'assistant'; text: string; time?: string; source?: string; updatedAt?: string; streaming?: boolean;
  feedback?: string; onFeedback?: (value: string) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  return <article className={`ai-card ai-message ${role}`} aria-label={role === 'user' ? 'Your message' : 'Assistant response'} aria-busy={streaming}>
    {role === 'assistant' ? <header><IconSparkles size={14}/>Workspace assistant{time && <time>{time}</time>}</header> : time && <header><time>{time}</time></header>}
    <div className="ai-message-text" aria-live={streaming ? 'polite' : 'off'}>{text}</div>
    {(source || updatedAt) && <footer>{source && `Source: ${source}`}{source && updatedAt && ' · '}{updatedAt && `Updated ${updatedAt}`}</footer>}
    {role === 'assistant' && <div className="ai-message-actions"><button aria-label="Copy response" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopyStatus('Copied'); } catch { setCopyStatus('Could not copy'); } }}><IconCopy size={14}/></button>{onFeedback && ['Helpful', 'Accurate', 'Needs work'].map(value => <button key={value} className="ai-reaction" aria-pressed={feedback === value} onClick={() => onFeedback(value)}>{value}</button>)}<span role="status">{copyStatus}</span></div>}
  </article>;
}

export function ChatPending({ label = 'Assistant is preparing a response' }: { label?: string }) {
  return <div className="ai-card ai-pending" role="status"><i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/><span>{label}</span></div>;
}

export function ChatApproval({ title, description, records, status = 'pending', onApprove, onCancel }: {
  title: string; description: string; records: { id: string; label: string }[]; status?: 'pending' | 'approved' | 'submitting' | 'error';
  onApprove?: (ids: string[]) => void; onCancel?: () => void;
}) {
  const [selected, setSelected] = useState(() => records.map(record => record.id));
  const visibleSelection = selected.filter(id => records.some(record => record.id === id));
  const actionable = status === 'pending' && !!onApprove;
  return <section className="ai-card" aria-label="Proposed operation" aria-busy={status === 'submitting'}><strong>{title}</strong><p>{description}</p>
    {records.map(record => <label key={record.id}><input type="checkbox" checked={selected.includes(record.id)} disabled={!actionable} onChange={event => setSelected(ids => event.target.checked ? [...ids, record.id] : ids.filter(id => id !== record.id))}/>{record.label}</label>)}
    <div className="ai-card-actions"><button className="btn btn-outline" disabled={!actionable || !onCancel} onClick={onCancel}>Cancel</button><button className="btn btn-dark" disabled={!actionable || !visibleSelection.length} onClick={() => onApprove?.(visibleSelection)}>{status === 'approved' ? 'Approved' : status === 'submitting' ? 'Submitting…' : 'Approve selection'}</button></div>
    {!onApprove && <small>Approval service is not connected.</small>}{status === 'error' && <p role="alert" className="ai-error">The operation did not complete.</p>}
  </section>;
}

export function ChatQuestion({ question, options, onAnswer }: { question: string; options: string[]; onAnswer?: (answer: string) => void }) {
  const id = useId(); const [selected, setSelected] = useState('');
  return <fieldset className="ai-card"><legend>{question}</legend>{options.map(option => <label key={option}><input type="radio" name={id} value={option} checked={selected === option} onChange={() => setSelected(option)}/>{option}</label>)}<div className="ai-card-actions"><button className="btn btn-dark" disabled={!selected || !onAnswer} onClick={() => onAnswer?.(selected)}>Continue</button></div></fieldset>;
}

export function ChatQueue({ items, onEdit, onCancel }: { items: { id: string; text: string }[]; onEdit?: (id: string) => void; onCancel?: (id: string) => void }) {
  if (!items.length) return null;
  return <section className="ai-card" aria-label="Queued requests"><strong>Queued requests · {items.length}</strong>{items.map(item => <div key={item.id} className="ai-queue-row"><span>{item.text}</span>{onEdit && <button className="btn-icon" onClick={() => onEdit(item.id)} aria-label={`Edit ${item.text}`}>Edit</button>}{onCancel && <button className="btn-icon" onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.text}`}><IconX size={14}/></button>}</div>)}</section>;
}

export function ChatContextCard({ title, description, updatedAt, onManage }: { title: string; description: string; updatedAt?: string; onManage?: () => void }) {
  return <section className="ai-card"><strong>{title}</strong><p>{description}</p>{updatedAt && <small>Updated {updatedAt}</small>}{onManage && <button className="btn btn-outline" onClick={onManage}>Manage context</button>}</section>;
}
export function ChatHistoryCard({ title, preview, selected, onSelect }: { title: string; preview: string; selected?: boolean; onSelect: () => void }) {
  return <button className="ai-card ai-history-card" aria-current={selected ? 'true' : undefined} onClick={onSelect}><strong>{title}</strong><small>{preview}</small></button>;
}
export function ChatUnread() { return <div className="ai-unread" role="separator">New</div>; }
