import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconArrowLeft, IconMail,
  IconTrash, IconChevronDown, IconChevronRight,
  IconTimeline, IconNotes, IconPlus, IconSend,
} from '@tabler/icons-react';
import { api } from '../api';
import { timeAgo } from '../lib/timeAgo';

// ── Colours ───────────────────────────────────────────────────────────────────
const avatarColors = [
  { bg: '#dbe9fe', color: '#1961ed' },
  { bg: '#d9f0de', color: '#2a8e44' },
  { bg: '#fdf2d4', color: '#946c00' },
  { bg: '#f1e6fd', color: '#7d3bc8' },
  { bg: '#fde2ef', color: '#c2185d' },
];
const getColor = (name: string) => avatarColors[(name?.charCodeAt(0) ?? 0) % avatarColors.length];

const actionColors: Record<string, { bg: string; color: string }> = {
  created: { bg: '#d9f0de', color: '#2a8e44' },
  updated: { bg: '#dbe9fe', color: '#1961ed' },
  deleted: { bg: '#fdded9', color: '#d93025' },
  login:   { bg: '#f1e6fd', color: '#7d3bc8' },
  logout:  { bg: '#f1f1f1', color: '#666666' },
};
const getActionColor = (action: string) => {
  const verb = action?.split('.')[1] ?? '';
  return actionColors[verb] ?? { bg: '#f1f1f1', color: '#666' };
};

function groupByMonth(items: any[]) {
  const map = new Map<string, any[]>();
  for (const item of items) {
    const key = new Date(item.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

// ── Field helpers ─────────────────────────────────────────────────────────────
function FieldRow({ label, value }: { label: string; value?: string | number | boolean | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ minWidth: 120, fontSize: 12, color: 'var(--font-tertiary)', paddingTop: 1 }}>{label}</span>
      <span style={{ fontSize: 12, color: 'var(--font-primary)', flex: 1 }}>
        {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}
      </span>
    </div>
  );
}

function Section({ label, children, defaultOpen = true }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, width: '100%',
          background: 'none', border: 'none', padding: '8px 0 4px', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: 'var(--font-tertiary)',
        }}
      >
        {open ? <IconChevronDown size={12}/> : <IconChevronRight size={12}/>}
        {label}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

// ── Two-layer placeholder (background + foreground image, like Twenty CRM) ────
function PlaceholderState({
  bg, fg, title, subtitle, action,
}: {
  bg: string; fg: string;
  title: string; subtitle: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 20 }}>
      {/* Image layers */}
      <div style={{ position: 'relative', width: 160, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <img src={bg} alt="" draggable={false} style={{ maxWidth: 160, maxHeight: 160, userSelect: 'none' }} />
        <img src={fg} alt="" draggable={false} style={{ position: 'absolute', maxWidth: 130, maxHeight: 130, userSelect: 'none', zIndex: 2 }} />
      </div>

      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--font-primary)', marginBottom: 6 }}>{title}</p>
        <p style={{ fontSize: 13, color: 'var(--font-tertiary)', maxWidth: 300, lineHeight: 1.55 }}>{subtitle}</p>
      </div>

      {action && (
        <button onClick={action.onClick} className="btn btn-outline" style={{ marginTop: 4, gap: 6 }}>
          {action.label}
        </button>
      )}
    </div>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────
type Tab = 'timeline' | 'notes' | 'emails';

const TABS: { key: Tab; label: string; Icon: React.FC<any> }[] = [
  { key: 'timeline', label: 'Timeline', Icon: IconTimeline },
  { key: 'notes',    label: 'Notes',    Icon: IconNotes    },
  { key: 'emails',   label: 'Emails',   Icon: IconMail     },
];

// ── Notes stored in localStorage per user ─────────────────────────────────────
type Note = { id: string; text: string; createdAt: string };

function useNotes(userId: string) {
  const key = `user-notes-${userId}`;
  const [notes, setNotes] = useState<Note[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
  });
  const save = (next: Note[]) => { setNotes(next); localStorage.setItem(key, JSON.stringify(next)); };
  const add = (text: string) => save([{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }, ...notes]);
  const remove = (id: string) => save(notes.filter(n => n.id !== id));
  return { notes, add, remove };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function UserProfile() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('timeline');
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  const { notes, add: addNote, remove: removeNote } = useNotes(id ?? '');

  const { data: user, isLoading } = useQuery({
    queryKey: ['user', id],
    queryFn: async () => { const { data } = await api.get(`/users/${id}`); return data; },
    enabled: !!id,
  });

  const { data: auditData } = useQuery({
    queryKey: ['audit-logs', 'full'],
    queryFn: async () => { const { data } = await api.get('/audit-logs', { params: { page: 1, limit: 500 } }); return data; },
  });

  const timeline = (auditData?.items ?? []).filter(
    (l: any) => l.targetId === id || l.actorId === id
  );

  const toggleActive = useMutation({
    mutationFn: (isActive: boolean) => api.patch(`/users/${id}`, { isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user', id] }); qc.invalidateQueries({ queryKey: ['users'] }); },
  });

  const deactivate = useMutation({
    mutationFn: () => api.delete(`/users/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); nav('/users'); },
  });

  useEffect(() => {
    const handler = () => { if (user) window.open(`mailto:${user.email}`); };
    document.addEventListener('trigger-send-email', handler);
    return () => document.removeEventListener('trigger-send-email', handler);
  }, [user]);

  const exportUser = () => {
    if (!user) return;
    const blob = new Blob([JSON.stringify(user, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `user-${user.username}.json` });
    a.click();
  };

  const submitNote = () => {
    if (!noteText.trim()) return;
    addNote(noteText.trim());
    setNoteText('');
    setAddingNote(false);
  };

  if (isLoading) return <div className="page"><p className="muted" style={{ padding: 24 }}>Loading…</p></div>;
  if (!user) return <div className="page"><p className="muted" style={{ padding: 24 }}>User not found.</p></div>;

  const c = getColor(user.fullName || 'A');
  const grouped = groupByMonth(timeline);

  return (
    <div className="page" style={{ flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Page topbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: 44, borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
        <Link to="/users" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--font-tertiary)', textDecoration: 'none', fontSize: 13 }}>
          <IconArrowLeft size={14}/>
          Users
        </Link>
        <span style={{ color: 'var(--border-medium)', margin: '0 2px' }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--font-primary)', fontWeight: 500 }}>{user.fullName}</span>
        <span style={{ flex: 1 }}/>
      </div>

      {/* ── Two-column body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Left: fields panel ── */}
        <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border-light)', overflowY: 'auto', padding: '24px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 24, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: c.bg, color: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700 }}>
              {user.fullName?.[0]}
            </div>
            <div>
              <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--font-primary)', margin: 0 }}>{user.fullName}</p>
              <p style={{ fontSize: 12, color: 'var(--font-tertiary)', margin: '2px 0 0' }}>Added {timeAgo(user.createdAt)}</p>
            </div>
            <span className={`badge badge-${user.isActive ? 'active' : 'inactive'}`}>{user.isActive ? 'Active' : 'Inactive'}</span>
          </div>

          <div style={{ fontSize: 13 }}>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--font-tertiary)', marginBottom: 8 }}>Fields</p>

            <Section label="General">
              <FieldRow label="Role" value={user.role}/>
              <FieldRow label="Username" value={`@${user.username}`}/>
              <FieldRow label="Work Email" value={user.email}/>
              <FieldRow label="Job Title" value={user.jobTitle}/>
              <FieldRow label="Department" value={user.department}/>
              <FieldRow label="Employment Type" value={user.employmentType}/>
            </Section>

            <Section label="Personal">
              <FieldRow label="Date of Birth" value={user.dateOfBirth ? new Date(user.dateOfBirth).toLocaleDateString('en-GB') : null}/>
              <FieldRow label="Phone" value={user.phoneNumber}/>
              <FieldRow label="Gender" value={user.gender}/>
              <FieldRow label="Nationality" value={user.nationality}/>
              <FieldRow label="Marital Status" value={user.maritalStatus}/>
              <FieldRow label="Personal Email" value={user.personalEmail}/>
            </Section>

            <Section label="Employment" defaultOpen={false}>
              <FieldRow label="Office Location" value={user.officeLocation}/>
              <FieldRow label="Hire Date" value={user.hireDate ? new Date(user.hireDate).toLocaleDateString('en-GB') : null}/>
              <FieldRow label="Start Date" value={user.startDate ? new Date(user.startDate).toLocaleDateString('en-GB') : null}/>
              <FieldRow label="Probation End" value={user.probationEndDate ? new Date(user.probationEndDate).toLocaleDateString('en-GB') : null}/>
              <FieldRow label="Notice Period" value={user.noticePeriod}/>
              <FieldRow label="Work Schedule" value={user.workSchedule}/>
              <FieldRow label="Salary" value={user.salary ? `£${Number(user.salary).toLocaleString()}` : null}/>
              <FieldRow label="Hourly Rate" value={user.hourlyRate ? `£${Number(user.hourlyRate).toFixed(2)}/hr` : null}/>
              <FieldRow label="Overtime Eligible" value={user.overtimeEligible}/>
              <FieldRow label="Pension Eligible" value={user.pensionEligible}/>
            </Section>

            <Section label="Contact" defaultOpen={false}>
              <FieldRow label="Address" value={[user.addressLine1, user.addressLine2].filter(Boolean).join(', ')}/>
              <FieldRow label="City" value={user.city}/>
              <FieldRow label="County / State" value={user.countyState}/>
              <FieldRow label="Postal Code" value={user.postalCode}/>
              <FieldRow label="Country" value={user.country}/>
            </Section>

            <Section label="Bank Account" defaultOpen={false}>
              <FieldRow label="Account Holder" value={user.bankAccountHolder}/>
              <FieldRow label="Bank Name" value={user.bankName}/>
              <FieldRow label="Account Number" value={user.bankAccountNumber ? '••••' + user.bankAccountNumber.slice(-4) : null}/>
              <FieldRow label="Sort Code" value={user.bankSortCode}/>
              <FieldRow label="IBAN" value={user.bankIban}/>
              <FieldRow label="SWIFT / BIC" value={user.bankSwiftBic}/>
              <FieldRow label="Country" value={user.bankCountry}/>
              <FieldRow label="Currency" value={user.bankCurrency}/>
            </Section>

            <Section label="Emergency Contact" defaultOpen={false}>
              <FieldRow label="Name" value={user.emergencyContactName}/>
              <FieldRow label="Relationship" value={user.emergencyContactRelationship}/>
              <FieldRow label="Phone" value={user.emergencyContactPhone}/>
              <FieldRow label="Alt Phone" value={user.emergencyContactAltPhone}/>
              <FieldRow label="Email" value={user.emergencyContactEmail}/>
            </Section>

            <Section label="System" defaultOpen={false}>
              <FieldRow label="ID" value={user.id?.slice(0, 8) + '…'}/>
              <FieldRow label="Created" value={user.createdAt ? new Date(user.createdAt).toLocaleDateString('en-GB') : null}/>
              <FieldRow label="Updated" value={user.updatedAt ? new Date(user.updatedAt).toLocaleDateString('en-GB') : null}/>
            </Section>
          </div>
        </div>

        {/* ── Right: tabs + content ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', padding: '0 24px', flexShrink: 0 }}>
            {TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 14px', background: 'none', border: 'none',
                  borderBottom: tab === key ? '2px solid var(--font-primary)' : '2px solid transparent',
                  fontSize: 13, fontWeight: tab === key ? 600 : 400,
                  color: tab === key ? 'var(--font-primary)' : 'var(--font-tertiary)',
                  cursor: 'pointer', marginBottom: -1,
                }}
              >
                <Icon size={14} stroke={1.8}/>
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>

            {/* ── Timeline ── */}
            {tab === 'timeline' && (
              timeline.length === 0 ? (
                <PlaceholderState
                  bg="/images/placeholders/background/empty_timeline_bg.png"
                  fg="/images/placeholders/moving-image/empty_timeline.png"
                  title="No activity yet"
                  subtitle="There is no activity associated with this record."
                />
              ) : (
                Array.from(grouped.entries()).map(([month, entries]) => (
                  <div key={month} style={{ marginBottom: 24 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--font-tertiary)', marginBottom: 12 }}>{month}</p>
                    {entries.map((log: any) => {
                      const ac = getActionColor(log.action);
                      return (
                        <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: ac.bg, color: ac.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                            {log.actor?.fullName?.[0] ?? '?'}
                          </div>
                          <div style={{ flex: 1, fontSize: 13 }}>
                            <span style={{ fontWeight: 500, color: 'var(--font-secondary)' }}>{log.actor?.fullName ?? 'System'}</span>
                            {' '}
                            <span className="badge" style={{ background: ac.bg, color: ac.color, fontSize: 11 }}>{log.action?.replace(/[._]/g, ' ')}</span>
                            {log.metadata?.name && <span style={{ color: 'var(--font-tertiary)', marginLeft: 6, fontSize: 12 }}>{log.metadata.name}</span>}
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--font-tertiary)', flexShrink: 0 }}>{timeAgo(log.createdAt)}</span>
                        </div>
                      );
                    })}
                  </div>
                ))
              )
            )}

            {/* ── Notes ── */}
            {tab === 'notes' && (
              <div>
                {addingNote && (
                  <div style={{ marginBottom: 20, border: '1px solid var(--border-medium)', borderRadius: 8, overflow: 'hidden' }}>
                    <textarea
                      autoFocus
                      value={noteText}
                      onChange={e => setNoteText(e.target.value)}
                      placeholder="Write a note…"
                      rows={4}
                      style={{ width: '100%', padding: 12, border: 'none', outline: 'none', resize: 'none', fontSize: 13, fontFamily: 'inherit', background: 'var(--bg-primary)', color: 'var(--font-primary)' }}
                    />
                    <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border-light)', background: 'var(--bg-secondary)' }}>
                      <button className="btn btn-outline" onClick={() => { setAddingNote(false); setNoteText(''); }}>Cancel</button>
                      <button className="btn btn-dark" style={{ gap: 6 }} onClick={submitNote}>
                        <IconSend size={13}/>
                        Save note
                      </button>
                    </div>
                  </div>
                )}

                {notes.length === 0 && !addingNote ? (
                  <PlaceholderState
                    bg="/images/placeholders/background/no_note_bg.png"
                    fg="/images/placeholders/moving-image/no_note.png"
                    title="No notes"
                    subtitle="There are no associated notes with this record."
                    action={{ label: '+ New note', onClick: () => setAddingNote(true) }}
                  />
                ) : (
                  <>
                    {!addingNote && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                        <button className="btn btn-outline" style={{ gap: 6 }} onClick={() => setAddingNote(true)}>
                          <IconPlus size={13}/>
                          New note
                        </button>
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {notes.map(n => (
                        <div key={n.id} style={{ border: '1px solid var(--border-medium)', borderRadius: 8, padding: 14, background: 'var(--bg-primary)' }}>
                          <p style={{ fontSize: 13, color: 'var(--font-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{n.text}</p>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-light)' }}>
                            <span style={{ fontSize: 11, color: 'var(--font-tertiary)' }}>{timeAgo(n.createdAt)}</span>
                            <button onClick={() => removeNote(n.id)} className="btn-icon danger" title="Delete note">
                              <IconTrash size={13}/>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Emails ── */}
            {tab === 'emails' && (
              <PlaceholderState
                bg="/images/placeholders/background/empty_inbox_bg.png"
                fg="/images/placeholders/moving-image/empty_inbox.png"
                title="Empty Inbox"
                subtitle="No email exchange has occurred with this record yet."
                action={{ label: '✉ Send Email', onClick: () => window.open(`mailto:${user.email}`) }}
              />
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
