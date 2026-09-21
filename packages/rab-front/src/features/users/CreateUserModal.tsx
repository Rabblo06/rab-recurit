import { useState, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { checkPasswordStrength, generateSecurePassword } from '@rab/shared';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import AccordionSection from '../../shared/components/AccordionSection';
import DateInput, { todayIso } from '../../shared/components/DateInput';

type Role = 'staff' | 'manager';

const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'];
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const empty = {
  email: '',
  firstName: '',
  lastName: '',
  phone: '',
  // staff only
  staffRef: '',
  startDate: '',
  hourlyRate: '',
  dateOfBirth: '',
  jobRoleId: '',
  emergencyContactName: '',
  emergencyContactRelationship: '',
  emergencyContactPhone: '',
  // staff only — a Manager-reference credential only, never the staff
  // member's real one; see the field's own help text and CreateStaffDto's
  // doc comment for why.
  temporaryPassword: '',
  preferredName: '',
  employmentType: '',
  address: '',
  city: '',
  postcode: '',
  otherSkills: '',
  yearsExperience: '',
  availableDays: [] as string[],
  preferredShiftTimes: '',
  maxHoursPerWeek: '',
  rightToWorkStatus: '',
  documentType: '',
  expiryDate: '',
  languages: '',
  workNotes: '',
  // manager only
  managerType: 'internal' as 'internal' | 'venue',
  jobTitle: '',
  venueId: '',
};

type FormState = typeof empty;
type FieldKey = keyof FormState;

// Staff creation only — Manager creation stays a single page (it's already
// just 3 short fields, a wizard would be pure overhead). One step per
// existing section, same order/keys the old accordion used, so REQUIRED's
// `section` values below still line up unchanged.
const STAFF_STEPS = [
  { key: 'personal', title: 'Personal Details' },
  { key: 'employment', title: 'Employment' },
  { key: 'general', title: 'General' },
  { key: 'emergency', title: 'Emergency Contact' },
  { key: 'work', title: 'Work Information' },
  { key: 'availability', title: 'Availability' },
  { key: 'rtw', title: 'Right to Work' },
  { key: 'additional', title: 'Additional' },
] as const;

/** One row inside an expanded section — the same label-above/input-below shape Detail mode's `EditableField` collapses down to on save, so create and edit read as the same system, not two. */
function FormField({
  label, required, children, fieldRef,
}: { label: string; required?: boolean; children: React.ReactNode; fieldRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div className="field" ref={fieldRef as React.Ref<HTMLDivElement>}>
      <label>{label}{required ? ' *' : ''}</label>
      {children}
    </div>
  );
}

interface CreatedInvite {
  sendNumber: number;
  queued: boolean;
}

/**
 * Global create-staff/create-manager side panel. Opened from anywhere via:
 *   document.dispatchEvent(new CustomEvent('open-create-user', { detail: { role: 'staff' | 'manager' } }))
 *
 * Staff creation is a step-by-step wizard (one `AccordionSection`-worth of
 * fields per step); Manager creation stays the original single-page
 * accordion, both sharing `UserDetailPanel`'s Home tab visual language so
 * create and detail read as one system. Only fields the real API accepts
 * (`CreateStaffDto`) are ever sent — `forbidNonWhitelisted` on the backend
 * 400s on anything else. Every field wired through to `StaffProfile`. "Job
 * role" reuses the existing `JobRole` entity built for Shift creation
 * (`GET /job-roles`) — Work Information's "Primary job role" row mirrors the
 * same selection read-only rather than duplicating it as a second editable
 * field, source of truth stays singular.
 *
 * Staff creation also accepts an optional "Temporary password" — a
 * Manager-reference credential only (may generate one via
 * `generateSecurePassword`), hashed server-side into a separate column
 * `AuthService.login()` never reads. It is NEVER the staff member's real,
 * usable credential: the account is still created PENDING and only
 * activates via the staff member's own password set through the emailed
 * invitation link, then their own first successful login — see
 * `AccountInviteService`/`AuthService.login()`.
 */
export default function CreateUserModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('staff');
  const [form, setForm] = useState<FormState>({ ...empty });
  const [error, setError] = useState('');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['personal', 'employment', 'general']));
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState(0);
  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLDivElement | null>>>({});

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setRole(detail.role === 'manager' ? 'manager' : 'staff');
      setForm({ ...empty });
      setError('');
      setCreatedInvite(null);
      setOpenSections(new Set(['personal', 'employment', 'general']));
      setShowPassword(false);
      setStep(0);
      setOpen(true);
    };
    document.addEventListener('open-create-user', handler);
    return () => document.removeEventListener('open-create-user', handler);
  }, []);

  // Same panel-exclusivity rule as UserDetailPanel's own — see its comment.
  useEffect(() => {
    const closeOnOtherPanel = () => setOpen(false);
    document.addEventListener('open-user-detail', closeOnOtherPanel);
    document.addEventListener('open-bulk-email', closeOnOtherPanel);
    return () => {
      document.removeEventListener('open-user-detail', closeOnOtherPanel);
      document.removeEventListener('open-bulk-email', closeOnOtherPanel);
    };
  }, []);

  const { data: jobRoles = [] } = useQuery({
    queryKey: ['job-roles'],
    queryFn: async () => { const { data } = await api.get('/job-roles'); return data; },
    enabled: open && role === 'staff',
  });

  // A suggestion only — never trusted as authoritative (the backend's own
  // uniqueness check + 23505-to-409 handling in StaffService.create() is
  // what's actually safe under concurrency). Never overwrites a value the
  // manager has already typed — `form.staffRef` starts `''` on every fresh
  // open, so this only ever fills a genuinely empty field.
  const { data: nextRef } = useQuery({
    queryKey: ['staff-next-reference'],
    queryFn: async () => { const { data } = await api.get('/staff/next-reference'); return data as { staffRef: string }; },
    enabled: open && role === 'staff',
  });
  useEffect(() => {
    if (nextRef?.staffRef) setForm((p) => (p.staffRef ? p : { ...p, staffRef: nextRef.staffRef }));
  }, [nextRef]);

  const venues = useQuery({
    queryKey: ['venues', 'for-manager-assignment'],
    queryFn: async () => { const { data } = await api.get<{ data: { id: string; name: string }[] }>('/venues', { params: { status: 'active' } }); return data.data; },
    enabled: open && role === 'manager' && form.managerType === 'venue',
  });

  const create = useMutation({
    mutationFn: (): Promise<any> => {
      if (role === 'staff') {
        const pounds = parseFloat(form.hourlyRate);
        return api.post('/staff', {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          staffRef: form.staffRef,
          startDate: form.startDate || undefined,
          defaultPayRatePence: Number.isFinite(pounds) ? Math.round(pounds * 100) : undefined,
          dateOfBirth: form.dateOfBirth || undefined,
          jobRoleId: form.jobRoleId || undefined,
          emergencyContactName: form.emergencyContactName || undefined,
          emergencyContactRelationship: form.emergencyContactRelationship || undefined,
          emergencyContactPhone: form.emergencyContactPhone || undefined,
          temporaryPassword: form.temporaryPassword || undefined,
          preferredName: form.preferredName || undefined,
          employmentType: form.employmentType || undefined,
          address: form.address || undefined,
          city: form.city || undefined,
          postcode: form.postcode || undefined,
          otherSkills: form.otherSkills || undefined,
          yearsExperience: form.yearsExperience ? Number(form.yearsExperience) : undefined,
          availableDays: form.availableDays.length > 0 ? form.availableDays : undefined,
          preferredShiftTimes: form.preferredShiftTimes || undefined,
          maxHoursPerWeek: form.maxHoursPerWeek ? Number(form.maxHoursPerWeek) : undefined,
          rightToWorkStatus: form.rightToWorkStatus || undefined,
          documentType: form.documentType || undefined,
          expiryDate: form.expiryDate || undefined,
          languages: form.languages ? form.languages.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          notes: form.workNotes || undefined,
        });
      }
      return api.post('/managers', {
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
        type: form.managerType,
        jobTitle: form.jobTitle || undefined,
      }).then(async (res) => {
        // Venue assignment is a separate, already-existing endpoint
        // (`POST /managers/:id/venues`) — reused as-is here rather than
        // folded into CreateManagerDto, matching the backend's own
        // create-then-assign shape (ManagerService.create never writes
        // ManagerVenue itself).
        if (form.managerType === 'venue' && form.venueId) {
          await api.post(`/managers/${res.data.id}/venues`, { venueId: form.venueId });
        }
        return res;
      });
    },
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: [role === 'staff' ? 'staff' : 'managers'] });
      setCreatedInvite({ sendNumber: data.invite?.sendNumber ?? 1, queued: data.invite?.queued ?? data.emailQueued ?? false });
      // Preferred flow: the create panel becomes the new record's own Detail
      // panel — the header then reflects real, server-returned data, not
      // this form's local preview state.
      document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: data.id, type: role } }));
    },
    onError: (e: any) => {
      const message = e?.response?.data?.message;
      const text = Array.isArray(message) ? message.join(', ') : message ?? 'Failed to create.';
      setError(text);
      // Best-effort: point the wizard back at the step most likely to own
      // this error, rather than leaving the manager stranded on the final
      // step wondering which of the 8 steps the backend is complaining
      // about. Entered data is untouched either way (the request only ever
      // fires from the final step, and failure never resets `form`).
      if (role === 'staff') {
        const lower = text.toLowerCase();
        if (lower.includes('password')) setStep(STAFF_STEPS.findIndex((s) => s.key === 'general'));
        else if (lower.includes('email')) setStep(STAFF_STEPS.findIndex((s) => s.key === 'general'));
        else if (lower.includes('staff') || lower.includes('reference')) setStep(STAFF_STEPS.findIndex((s) => s.key === 'employment'));
      }
    },
  });

  // Clearing `error` here — not just inside goNext()/goBack() — is what
  // fixes the stale-validation bug: editing any field on the current step
  // (including via Generate password, which calls setForm directly, not
  // through this closure) immediately drops whatever error was showing,
  // rather than leaving a message like "Temporary password is required."
  // on screen after the field has already been filled.
  const f = (key: FieldKey) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setError('');
      setForm(p => ({ ...p, [key]: e.target.value }));
    };

  const toggleAvailableDay = (day: string) => {
    setError('');
    setForm((p) => ({
      ...p,
      availableDays: p.availableDays.includes(day)
        ? p.availableDays.filter((d) => d !== day)
        : [...p.availableDays, day],
    }));
  };

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const isDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(empty), [form]);
  const close = () => setOpen(false);

  const previewName = `${form.firstName} ${form.lastName}`.trim();
  const previewInitials = (form.firstName[0] ?? '') + (form.lastName[0] ?? '');
  const title = previewName || (role === 'staff' ? 'Create staff member' : 'Create manager');

  // Section → required fields shown in it, in display order — used to
  // auto-open the right section and focus the first empty one on a failed
  // submit attempt, rather than a generic "fill in required fields" error.
  const REQUIRED: Array<{ section: string; key: FieldKey; label: string }> = role === 'staff'
    ? [
        { section: 'personal', key: 'firstName', label: 'First name' },
        { section: 'personal', key: 'lastName', label: 'Last name' },
        { section: 'employment', key: 'staffRef', label: 'Staff reference' },
        { section: 'general', key: 'email', label: 'Email' },
        { section: 'general', key: 'phone', label: 'Mobile number' },
        { section: 'general', key: 'temporaryPassword', label: 'Temporary password' },
        { section: 'emergency', key: 'emergencyContactName', label: 'Emergency contact full name' },
        { section: 'emergency', key: 'emergencyContactRelationship', label: 'Emergency contact relationship' },
        { section: 'emergency', key: 'emergencyContactPhone', label: 'Emergency contact phone number' },
      ]
    : [
        { section: 'personal', key: 'firstName', label: 'First name' },
        { section: 'personal', key: 'lastName', label: 'Last name' },
        { section: 'general', key: 'email', label: 'Email' },
        ...(form.managerType === 'venue'
          ? [{ section: 'employment', key: 'venueId' as FieldKey, label: 'Select Venue' }]
          : []),
      ];

  const isWizard = role === 'staff';
  const lastStepIndex = STAFF_STEPS.length - 1;

  const focusField = (key: FieldKey) => {
    // Let the step switch (state update + re-render) happen before focusing.
    setTimeout(() => {
      const el = fieldRefs.current[key];
      el?.querySelector<HTMLElement>('input, select')?.focus();
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
  };

  // One step's required fields, in order — reuses REQUIRED as-is (backend
  // required-ness is unchanged, only how it's surfaced is). General also
  // gets the same password-strength gate `submit()` used to run only at
  // the very end — checking it as soon as the manager leaves that step is
  // better UX than only discovering it on the final Create click.
  const validateStep = (stepIndex: number): { key: FieldKey; message: string } | null => {
    const sectionKey = STAFF_STEPS[stepIndex].key;
    for (const req of REQUIRED.filter((r) => r.section === sectionKey)) {
      if (!String(form[req.key] ?? '').trim()) return { key: req.key, message: `${req.label} is required.` };
    }
    if (sectionKey === 'general' && !checkPasswordStrength(form.temporaryPassword, form.email).valid) {
      return { key: 'temporaryPassword', message: 'Temporary password does not meet the password policy.' };
    }
    return null;
  };

  const goNext = () => {
    const invalid = validateStep(step);
    if (invalid) {
      setError(invalid.message);
      focusField(invalid.key);
      return;
    }
    setError('');
    setStep((s) => Math.min(s + 1, lastStepIndex));
  };

  const goBack = () => {
    setError('');
    setStep((s) => Math.max(s - 1, 0));
  };

  const submit = () => {
    setError('');
    if (isWizard) {
      // Belt-and-braces: `goNext` already re-validates every step on the
      // way through, so by construction all of 0..lastStepIndex-1 are
      // valid once the manager reaches the last step. Re-checking all of
      // them here (rather than trusting that) is what lets this also catch
      // and jump back to whichever step is actually invalid, instead of
      // silently failing, if that invariant is ever violated.
      for (let i = 0; i < STAFF_STEPS.length; i++) {
        const invalid = validateStep(i);
        if (invalid) {
          setStep(i);
          setError(invalid.message);
          focusField(invalid.key);
          return;
        }
      }
      create.mutate();
      return;
    }
    for (const req of REQUIRED) {
      if (!String(form[req.key] ?? '').trim()) {
        setOpenSections((s) => new Set([...s, req.section]));
        setError(`${req.label} is required.`);
        // Let the accordion open (state update + re-render) before focusing.
        setTimeout(() => {
          const el = fieldRefs.current[req.key];
          el?.querySelector<HTMLElement>('input, select')?.focus();
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 50);
        return;
      }
    }
    create.mutate();
  };

  const selectedJobRole = jobRoles.find((r: any) => r.id === form.jobRoleId);
  const passwordStrength = form.temporaryPassword ? checkPasswordStrength(form.temporaryPassword, form.email) : null;

  const generatePassword = () => {
    setError('');
    setForm(p => ({ ...p, temporaryPassword: generateSecurePassword() }));
    setShowPassword(true);
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={title}
      description={createdInvite ? undefined : 'Creating…'}
      avatar={!createdInvite && (
        <div className="avatar-panel">{previewInitials || '?'}</div>
      )}
      compactHeader
      loading={create.isPending}
      dirty={isDirty && !createdInvite}
      footer={
        createdInvite ? null : isWizard ? (
          <>
            <button className="btn btn-outline" onClick={step === 0 ? close : goBack}>
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            {step === lastStepIndex ? (
              <button className="btn btn-dark" disabled={create.isPending} onClick={submit}>
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            ) : (
              <button className="btn btn-dark" onClick={goNext}>Next</button>
            )}
          </>
        ) : (
          <>
            <button className="btn btn-outline" onClick={close}>Cancel</button>
            {/* Not pre-disabled on incomplete fields — clicking with something
                missing is what drives the auto-open+focus flow below (the
                spec's own explicit requirement); only disabled while a
                request is already in flight, to block a double-submit. */}
            <button className="btn btn-dark" disabled={create.isPending} onClick={submit}>
              {create.isPending ? 'Creating…' : 'Create manager'}
            </button>
          </>
        )
      }
    >
      {createdInvite ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {createdInvite.queued ? (
            <p style={{ fontSize: 13 }}>
              Account created. An invitation email has been queued for delivery — they&apos;ll set
              their own password to activate the account (Invitation {createdInvite.sendNumber} of 3,
              expires in 24 hours). Opening their detail panel…
            </p>
          ) : (
            <p className="error" style={{ fontSize: 13 }}>
              Account created, but the invitation email could not be queued. Use &quot;Resend
              Invitation&quot; from the account&apos;s details to try again.
            </p>
          )}
        </div>
      ) : isWizard ? (
        <div>
          <div className="wizard-progress">
            <span className="wizard-progress-label">Step {step + 1} of {STAFF_STEPS.length}</span>
          </div>
          <div className="wizard-progress-track">
            <div className="wizard-progress-fill" style={{ width: `${((step + 1) / STAFF_STEPS.length) * 100}%` }} />
          </div>
          <div className="wizard-step-title">{STAFF_STEPS[step].title}</div>

          {STAFF_STEPS[step].key === 'personal' && (
            <>
              <div className="form-grid">
                <FormField label="First name" required fieldRef={(el) => { fieldRefs.current.firstName = el; }}>
                  <input value={form.firstName} onChange={f('firstName')} />
                </FormField>
                <FormField label="Last name" required fieldRef={(el) => { fieldRefs.current.lastName = el; }}>
                  <input value={form.lastName} onChange={f('lastName')} />
                </FormField>
              </div>
              <FormField label="Preferred name">
                <input value={form.preferredName} onChange={f('preferredName')} />
              </FormField>
              <FormField label="Date of birth">
                <DateInput value={form.dateOfBirth} onChange={(v) => { setError(''); setForm(p => ({ ...p, dateOfBirth: v })); }} max={todayIso()} />
              </FormField>
            </>
          )}

          {STAFF_STEPS[step].key === 'employment' && (
            <>
              <FormField label="Staff reference" required fieldRef={(el) => { fieldRefs.current.staffRef = el; }}>
                <input value={form.staffRef} onChange={f('staffRef')} placeholder="staff1" />
              </FormField>
              <FormField label="Job role">
                <select value={form.jobRoleId} onChange={f('jobRoleId')}>
                  <option value="">— None —</option>
                  {jobRoles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </FormField>
              <FormField label="Employment type">
                <select value={form.employmentType} onChange={f('employmentType')}>
                  <option value="">— Select employment type —</option>
                  {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FormField>
              <div className="form-grid">
                <FormField label="Start date">
                  <DateInput value={form.startDate} onChange={(v) => { setError(''); setForm(p => ({ ...p, startDate: v })); }} />
                </FormField>
                <FormField label="Default rate (£/hr)">
                  <input type="number" min="0" step="0.01" value={form.hourlyRate} onChange={f('hourlyRate')} placeholder="12.50" />
                </FormField>
              </div>
              <p className="field-hint">Status will be Pending until the invitation is accepted — it isn&apos;t set here.</p>
            </>
          )}

          {STAFF_STEPS[step].key === 'general' && (
            <>
              <FormField label="Email" required fieldRef={(el) => { fieldRefs.current.email = el; }}>
                <input type="email" value={form.email} onChange={f('email')} placeholder="jane@company.com" />
              </FormField>
              <FormField label="Mobile number" required fieldRef={(el) => { fieldRefs.current.phone = el; }}>
                <input value={form.phone} onChange={f('phone')} placeholder="+44 7700 900000" />
              </FormField>
              <FormField label="Temporary password" required fieldRef={(el) => { fieldRefs.current.temporaryPassword = el; }}>
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ paddingRight: 38 }}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={form.temporaryPassword}
                    onChange={f('temporaryPassword')}
                    placeholder="Temporary password"
                  />
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
                    onClick={() => setShowPassword(v => !v)}
                  >
                    {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                  </button>
                </div>
                {form.temporaryPassword && passwordStrength && !passwordStrength.valid && (
                  <ul className="field-strength-list">
                    {passwordStrength.reasons.map(r => <li key={r}>{r}</li>)}
                  </ul>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button type="button" className="btn btn-outline" onClick={generatePassword}>
                    Generate password
                  </button>
                </div>
              </FormField>
              <FormField label="Address">
                <input value={form.address} onChange={f('address')} />
              </FormField>
              <FormField label="City">
                <input value={form.city} onChange={f('city')} />
              </FormField>
              <FormField label="Postcode">
                <input value={form.postcode} onChange={f('postcode')} />
              </FormField>
            </>
          )}

          {STAFF_STEPS[step].key === 'emergency' && (
            <>
              <FormField label="Full name" required fieldRef={(el) => { fieldRefs.current.emergencyContactName = el; }}>
                <input value={form.emergencyContactName} onChange={f('emergencyContactName')} placeholder="Jane Doe" />
              </FormField>
              <div className="form-grid">
                <FormField label="Relationship" required fieldRef={(el) => { fieldRefs.current.emergencyContactRelationship = el; }}>
                  <input value={form.emergencyContactRelationship} onChange={f('emergencyContactRelationship')} placeholder="Spouse" />
                </FormField>
                <FormField label="Phone number" required fieldRef={(el) => { fieldRefs.current.emergencyContactPhone = el; }}>
                  <input value={form.emergencyContactPhone} onChange={f('emergencyContactPhone')} placeholder="+44 7700 900000" />
                </FormField>
              </div>
            </>
          )}

          {STAFF_STEPS[step].key === 'work' && (
            <>
              <div className="field">
                <label>Primary job role</label>
                <input disabled value={selectedJobRole?.name ?? ''} placeholder="Set above in Employment → Job role" />
              </div>
              <FormField label="Other roles / skills">
                <input value={form.otherSkills} onChange={f('otherSkills')} placeholder="Bartending, First aid, Forklift" />
              </FormField>
              <FormField label="Years of experience">
                <input type="number" min="0" max="60" value={form.yearsExperience} onChange={f('yearsExperience')} />
              </FormField>
            </>
          )}

          {STAFF_STEPS[step].key === 'availability' && (
            <>
              <FormField label="Available days">
                <div className="weekday-picker">
                  {WEEKDAYS.map((day) => (
                    <label key={day} className="weekday-picker-option">
                      <input
                        type="checkbox"
                        checked={form.availableDays.includes(day)}
                        onChange={() => toggleAvailableDay(day)}
                      />
                      {day.slice(0, 3)}
                    </label>
                  ))}
                </div>
              </FormField>
              <FormField label="Preferred shift times">
                <select value={form.preferredShiftTimes} onChange={f('preferredShiftTimes')}>
                  <option value="">— Select —</option>
                  {SHIFT_TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Maximum hours per week">
                <input type="number" min="0" max="168" value={form.maxHoursPerWeek} onChange={f('maxHoursPerWeek')} />
              </FormField>
            </>
          )}

          {STAFF_STEPS[step].key === 'rtw' && (
            <>
              <FormField label="Right-to-work status">
                <input value={form.rightToWorkStatus} onChange={f('rightToWorkStatus')} />
              </FormField>
              <FormField label="Document type">
                <input value={form.documentType} onChange={f('documentType')} />
              </FormField>
              <FormField label="Expiry date">
                <DateInput value={form.expiryDate} onChange={(v) => { setError(''); setForm(p => ({ ...p, expiryDate: v })); }} />
              </FormField>
            </>
          )}

          {STAFF_STEPS[step].key === 'additional' && (
            <>
              <FormField label="Languages">
                <input value={form.languages} onChange={f('languages')} placeholder="English, Tamil" />
              </FormField>
              <FormField label="Notes / relevant work information">
                <textarea value={form.workNotes} onChange={(e) => { setError(''); setForm(p => ({ ...p, workNotes: e.target.value })); }} rows={4} />
              </FormField>
            </>
          )}

          {error && <p className="error" style={{ margin: '10px 4px 0' }}>{error}</p>}
        </div>
      ) : (
        <div>
          <div className="detail-fields-title">Fields</div>

          <AccordionSection title="Personal Details" sectionKey="personal" open={openSections.has('personal')} onToggle={toggleSection}>
            <div className="form-grid">
              <FormField label="First name" required fieldRef={(el) => { fieldRefs.current.firstName = el; }}>
                <input value={form.firstName} onChange={f('firstName')} />
              </FormField>
              <FormField label="Last name" required fieldRef={(el) => { fieldRefs.current.lastName = el; }}>
                <input value={form.lastName} onChange={f('lastName')} />
              </FormField>
            </div>
          </AccordionSection>

          <AccordionSection title="Role" sectionKey="employment" open={openSections.has('employment')} onToggle={toggleSection}>
            <FormField label="Manager type">
              <select value={form.managerType} onChange={f('managerType') as any}>
                <option value="internal">Internal manager</option>
                <option value="venue">Venue manager</option>
              </select>
            </FormField>
            <FormField label="Job title">
              <input value={form.jobTitle} onChange={f('jobTitle')} placeholder="Operations Manager" />
            </FormField>
            {form.managerType === 'venue' && (
              <FormField label="Select Venue" required fieldRef={(el) => { fieldRefs.current.venueId = el; }}>
                <select value={form.venueId} onChange={f('venueId') as any}>
                  <option value="">Select a venue…</option>
                  {venues.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </FormField>
            )}
          </AccordionSection>

          <AccordionSection title="General" sectionKey="general" open={openSections.has('general')} onToggle={toggleSection}>
            <FormField label="Email" required fieldRef={(el) => { fieldRefs.current.email = el; }}>
              <input type="email" value={form.email} onChange={f('email')} placeholder="jane@company.com" />
            </FormField>
            <FormField label="Mobile number" required fieldRef={(el) => { fieldRefs.current.phone = el; }}>
              <input value={form.phone} onChange={f('phone')} placeholder="+44 7700 900000" />
            </FormField>
            <p className="field-hint">
              An invitation email will be sent to this address — they&apos;ll set their own
              password to activate the account.
            </p>
          </AccordionSection>

          {error && <p className="error" style={{ margin: '10px 4px 0' }}>{error}</p>}
        </div>
      )}
    </Drawer>
  );
}
