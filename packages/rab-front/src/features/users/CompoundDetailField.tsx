import { useRef, useState, useEffect } from 'react';
import { IconMapPin, IconUser } from '@tabler/icons-react';
import Popover from '../../shared/components/Popover';
import NameInput from './NameInput';
import AddressInput from './AddressInput';

type Props = { kind: 'name' | 'address'; record: { firstName?: string; lastName?: string; address?: string; city?: string; postcode?: string }; onSave: (patch: Record<string, unknown>) => Promise<unknown> };
export default function CompoundDetailField({ kind, record, onSave }: Props) {
  const anchor = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLFormElement>(null);
  const nested = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initial = () => ({ firstName: record.firstName ?? '', lastName: record.lastName ?? '', address: (record.address ?? '').split('\n')[0], address2: (record.address ?? '').split('\n').slice(1).join('\n'), city: record.city ?? '', postcode: record.postcode ?? '', state: '', country: '' });
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    if (!open) return;
    editor.current?.querySelector('input')?.focus();
    const trackNested = () => { const id = editor.current?.querySelector('[aria-haspopup="listbox"][aria-controls]')?.getAttribute('aria-controls'); nested.current = id ? document.getElementById(id)?.closest<HTMLElement>('[data-rab-portal]') ?? null : null; };
    document.addEventListener('mousedown', trackNested, true);
    return () => document.removeEventListener('mousedown', trackNested, true);
  }, [open]);
  const label = kind === 'name' ? 'Name' : 'Address';
  const Icon = kind === 'name' ? IconUser : IconMapPin;
  const display = kind === 'name' ? [record.firstName, record.lastName].filter(Boolean).join(' ') : [record.address?.replace(/\n/g, ', '), record.city, record.postcode].filter(Boolean).join(', ');
  const close = () => { if (!saving) { setOpen(false); anchor.current?.focus(); } };
  return <div className="detail-info-row">
    <span className="detail-info-label"><Icon size={15} stroke={1.5} aria-hidden="true"/>{label}{kind === 'name' ? ' *' : ''}</span>
    <button ref={anchor} type="button" className="compound-field-value" aria-label={'Edit ' + label + ' value'} aria-haspopup="dialog" aria-expanded={open} title={display} onClick={() => { setDraft(initial()); setError(''); setOpen(true); }}>{display || 'Empty'}</button>
    <Popover open={open} onClose={close} anchorRef={anchor} dismissExclusionRef={nested} minWidth={280} className="compound-field-popover" onEscape={() => !!editor.current?.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')}>
      <form ref={editor} onSubmit={async event => { event.preventDefault(); if(saving)return; setSaving(true);setError(''); try { await onSave(kind === 'name' ? {firstName:draft.firstName.trim(),lastName:draft.lastName.trim()} : {address:[draft.address,draft.address2,draft.state,draft.country].map(s=>s.trim()).filter(Boolean).join('\n'),city:draft.city,postcode:draft.postcode});setOpen(false);anchor.current?.focus(); } catch {setError('Unable to save. Please try again.');} finally {setSaving(false);} }}>
        <fieldset disabled={saving}>
          {kind === 'name' ? <NameInput firstName={draft.firstName} lastName={draft.lastName} defaultExpanded onChange={name=>setDraft(previous=>({...previous,...name}))}/> : <AddressInput {...draft} onChange={address=>setDraft(previous=>({...previous,...address}))}/>}
        </fieldset>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="compound-field-actions"><button type="button" className="btn" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || (kind==='name' && (!draft.firstName.trim() || !draft.lastName.trim()))}>{saving?'Saving…':'Save'}</button></div>
      </form>
    </Popover>
  </div>;
}
