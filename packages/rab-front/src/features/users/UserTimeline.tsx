import { SearchField } from '../../shared/components/arc/search-field/search-field';
import { useState } from 'react';
import { IconUser, IconChevronDown, IconFilter, IconHistory, IconLogin, IconLogout, IconMail, IconPencil, IconTrash, IconClock, IconCalendarEvent, IconCircleCheck, IconPlus, IconShieldLock } from '@tabler/icons-react';
import { timeAgo } from '../../shared/lib/timeAgo';
import './user-timeline.css';
export type TimelineEvent = { id: string; action: string; createdAt: string; actor?: { fullName?: string } | null };
function eventIcon(action: string) {
  if (/logout/.test(action)) return IconLogout;
  if (/login/.test(action)) return IconLogin;
  if (/password|auth|suspend/.test(action)) return IconShieldLock;
  if (/deleted|archived/.test(action)) return IconTrash;
  if (/email|invite|sent|reminder/.test(action)) return IconMail;
  if (/updated|edited|corrected/.test(action)) return IconPencil;
  if (/attendance|clock|check_in/.test(action)) return IconClock;
  if (/approved|confirmed|accepted|activated/.test(action)) return IconCircleCheck;
  if (/created/.test(action)) return IconPlus;
  if (/offer|shift|booking/.test(action)) return IconCalendarEvent;
  return IconHistory;
}
export default function UserTimeline({ items, loading, describeAction }: { items: TimelineEvent[]; loading: boolean; describeAction: (action: string) => string }) {
  const [expanded,setExpanded] = useState<string | null>(null);
  const [filterOpen,setFilterOpen] = useState(false);
  const [query,setQuery] = useState('');
  const groups = new Map<string, { title: string; items: TimelineEvent[] }>();
  for (const item of items.filter(event => [describeAction(event.action),event.actor?.fullName].join(' ').toLowerCase().includes(query.toLowerCase()))) {
    const date = new Date(item.createdAt);
    const valid = Number.isFinite(date.getTime());
    const key = valid ? date.getFullYear() + '-' + date.getMonth() : 'unknown';
    const title = valid ? date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Other activity';
    if (!groups.has(key)) groups.set(key, { title, items: [] });
    groups.get(key)!.items.push(item);
  }
  return <section className="user-activity-timeline" aria-label="Activity timeline" aria-busy={loading}>
    <div className="timeline-toolbar"><h2>Timeline</h2><button type="button" className="btn-icon" aria-label="Filter activity" aria-expanded={filterOpen} onClick={()=>{setFilterOpen(!filterOpen);setQuery('');}}><IconFilter size={15}/></button></div>{filterOpen&&<SearchField label="Search activity" type="text" className="timeline-filter" aria-label="Search activity" placeholder="Filter activity…" value={query} onChange={event=>setQuery(event.target.value)}/>}
    {loading ? <p className="cell-muted" role="status">Loading activity…</p> : !items.length ? <p className="cell-muted">No activity recorded yet.</p> :
      [...groups.entries()].map(([key, group]) => <section className="user-activity-month" key={key} aria-label={group.title}>
        <h3>{group.title}</h3>
        <ol>{group.items.map(item => {
          const Icon = eventIcon(item.action);
          const date = new Date(item.createdAt);
          const valid = Number.isFinite(date.getTime());
          return <li key={item.id}>
            <span className="user-activity-marker" aria-hidden="true"><Icon size={13} stroke={1.5} /></span>
            <div className="user-activity-description">
              <span className="timeline-summary" title={[item.actor?.fullName,describeAction(item.action)].filter(Boolean).join(' ')}>
              {item.actor?.fullName && <span className="user-activity-actor">{item.actor.fullName} </span>}
              <span>{describeAction(item.action)}</span></span> <button type="button" className="timeline-expand" aria-label={'Details: '+describeAction(item.action)} aria-expanded={expanded===item.id} aria-controls={'activity-'+item.id} onClick={()=>setExpanded(expanded===item.id?null:item.id)}><IconChevronDown size={13}/></button>
            </div>
            <time dateTime={valid ? date.toISOString() : undefined} title={valid ? date.toLocaleString('en-GB') : undefined}>{valid ? timeAgo(item.createdAt) : 'Unknown date'}</time>
            {expanded===item.id&&<div className="timeline-event-card" id={'activity-'+item.id}><strong><span className="timeline-card-icon"><Icon size={13}/></span>{describeAction(item.action)}</strong><dl><dt><IconHistory size={14}/>Activity</dt><dd>{describeAction(item.action)}</dd><dt><IconUser size={14}/>Created by</dt><dd>{item.actor?.fullName ? <span className="timeline-person"><span>{item.actor.fullName.charAt(0)}</span>{item.actor.fullName}</span> : 'Not recorded'}</dd><dt><IconCalendarEvent size={14}/>Created</dt><dd>{valid?timeAgo(item.createdAt):'Unknown date'}</dd></dl></div>}
          </li>;
        })}</ol>
      </section>)}
  </section>;
}
