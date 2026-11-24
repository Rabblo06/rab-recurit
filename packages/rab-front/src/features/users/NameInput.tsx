import { useId, useState, type Ref } from 'react';
import { IconListDetails } from '@tabler/icons-react';
import './name-input.css';

type Name = { firstName: string; lastName: string };
type Props = Name & { onChange: (name: Name) => void; fieldRef?: Ref<HTMLDivElement>; label?: string; partsRequired?: boolean; required?: boolean; defaultExpanded?: boolean };

export default function NameInput({ firstName, lastName, onChange, fieldRef, label = 'Name', partsRequired = true, required = true, defaultExpanded = false }: Props) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState<string | null>(null);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return (
    <div className="field person-name-field" ref={fieldRef}>
      <label htmlFor={id}>{label}{required ? ' *' : ''}</label>
      <div className="person-name-control">
        <div className="person-name-main">
          <input id={id} autoComplete="name" aria-required={required} placeholder="John Doe"
            value={draft ?? fullName} onBlur={() => setDraft(null)}
            onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              const [first = '', ...rest] = value.trim().split(/\s+/);
              onChange({ firstName: first, lastName: rest.join(' ') });
            }} />
          <button type="button" aria-label={expanded ? 'Collapse name fields' : 'Expand name fields'}
            aria-expanded={expanded} aria-controls={id + '-parts'} onClick={() => setExpanded(!expanded)}>
            <IconListDetails size={16} aria-hidden="true" />
          </button>
        </div>
        <div id={id + '-parts'} className="person-name-parts" hidden={!expanded}>
          <div>
            <label htmlFor={id + '-first'}>First name</label>
            <input id={id + '-first'} autoComplete="given-name" aria-required={partsRequired} placeholder="John"
              value={firstName} onChange={(event) => { setDraft(null); onChange({ firstName: event.target.value, lastName }); }} />
          </div>
          <div>
            <label htmlFor={id + '-last'}>Last name</label>
            <input id={id + '-last'} autoComplete="family-name" aria-required={partsRequired} placeholder="Doe"
              value={lastName} onChange={(event) => { setDraft(null); onChange({ firstName, lastName: event.target.value }); }} />
          </div>
        </div>
      </div>
    </div>
  );
}
