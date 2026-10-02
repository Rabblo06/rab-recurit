import { useState, useEffect, useMemo, useRef, useId, isValidElement, cloneElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconAlertCircle } from '@tabler/icons-react';
import { api } from '../../shared/api';
import Drawer from '../../shared/components/Drawer';
import AccordionSection from '../../shared/components/AccordionSection';
import DateInput, { todayIso } from '../../shared/components/DateInput';
import { toast } from '../../shared/lib/toast';
import PhoneInput from './PhoneInput';
import AvatarUploadButton from './AvatarUploadButton';
import { isValidEmail } from './validateEmail';

type Role = 'staff' | 'manager';

const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'];
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Sentinel `jobRoleId` value meaning "type your own role name" — never sent to the API as-is; resolved to a real `JobRole` id (via `POST /job-roles`) before `POST /staff` ever sees it, since `CreateStaffDto.jobRoleId` is `@IsUUID()`-validated and there is deliberately no free-text job-role concept in the schema (see `createJobRole` reuse below). */
const CUSTOM_JOB_ROLE_VALUE = '__custom_job_role__';

const empty = {
  email: '',
  firstName: '',
  lastName: '',
  phone: '',
  // staff only
  startDate: '',
  hourlyRate: '',
  dateOfBirth: '',
  jobRoleId: '',
  customJobRole: '',
  emergencyContactName: '',
  emergencyContactRelationship: '',
  emergencyContactPhone: '',
  preferredName: '',
  employmentType: '',
  address: '',
  city: '',
  postcode: '',
  availableDays: [] as string[],
  preferredShiftTimes: '',
  maxHoursPerWeek: '',
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
//
// Personal Details and Employment are merged into a single first step
// ('personal' is the sole key — the former 'employment' fields render as an
// in-page subsection beneath it, see the JSX below). Work Information,
// Right to Work and Additional (Languages/Notes) were removed from this
// wizard entirely — not hidden — per a deliberate scope cut: none of their
// fields (`otherSkills`, `yearsExperience`, `rightToWorkStatus`,
// `documentType`, `expiryDate`, `languages`, `notes`) are required by
// `CreateStaffDto` (all `@IsOptional()`), so simply no longer collecting
// them is a safe, backend-compatible change — no DTO or schema change
// needed. Those `StaffProfile` columns are untouched and stay editable from
// the Staff Detail panel for anyone who still needs them.
const STAFF_STEPS = [
  { key: 'personal', title: 'Personal Details' },
  { key: 'general', title: 'General' },
  { key: 'emergency', title: 'Emergency Contact' },
  { key: 'availability', title: 'Availability' },
] as const;

/**
 * One row inside an expanded section — the same label-above/input-below
 * shape Detail mode's `EditableField` collapses down to on save, so create
 * and edit read as the same system, not two.
 *
 * The label is programmatically associated with its control (`htmlFor`/
 * `id`), not just visually adjacent — when `children` is a single plain
 * element (the common case: one `<input>`/`<select>`), an id is generated
 * and cloned onto it automatically. For a compound control (the password
 * field's show/hide wrapper, the phone input) auto-cloning would only tag
 * the wrapping `<div>`, so those callers pass `inputId` explicitly and wire
 * it onto their own real input themselves.
 */
function FormField({
  label, required, children, fieldRef, inputId,
}: { label: string; required?: boolean; children: React.ReactNode; fieldRef?: React.Ref<HTMLDivElement>; inputId?: string }) {
  const generatedId = useId();
  const canAutoClone = !inputId && isValidElement(children) && !(children.props as Record<string, unknown>).id;
  const id = inputId ?? (canAutoClone ? generatedId : undefined);
  const content = canAutoClone ? cloneElement(children as React.ReactElement, { id }) : children;
  return (
    <div className="field" ref={fieldRef as React.Ref<HTMLDivElement>}>
      <label htmlFor={id}>{label}{required ? ' *' : ''}</label>
      {content}
    </div>
  );
}

interface CreatedInvite {
  sendNumber: number;
  queued: boolean;
}

/**
 * The one email input + validation UI, shared by both the staff wizard's
 * General step and the manager form's General section — never duplicated.
 * Silent while untouched/empty; red border + icon + message once touched
 * and invalid, green border + check once touched and valid. Validation
 * itself (on blur, and again as a hard gate on Next/Create) lives in the
 * caller — this component only renders whatever `touched` already decided.
 */
function EmailField({ value, onChange, touched, onTouched, serverError, fieldRef }: {
  value: string;
  onChange: (v: string) => void;
  touched: boolean;
  onTouched: () => void;
  /** A server-rejected value (e.g. "A user with this email already exists.") — takes priority over the client-side format check, even if the format itself is valid. Cleared by the caller as soon as the field is edited. */
  serverError?: string | null;
  fieldRef?: React.Ref<HTMLDivElement>;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const trimmed = value.trim();
  const formatValid = trimmed !== '' && isValidEmail(value);
  const showInvalid = !!serverError || (touched && trimmed !== '' && !formatValid);
  const showValid = !serverError && touched && trimmed !== '' && formatValid;
  const message = serverError || 'Please enter a valid email address.';
  return (
    <FormField label="Email" required fieldRef={fieldRef} inputId={id}>
      <div className={`field-input-wrap${showInvalid ? ' invalid' : showValid ? ' valid' : ''}`}>
        <input
          id={id}
          type="email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onTouched}
          placeholder="jane@company.com"
          aria-invalid={showInvalid || undefined}
          aria-describedby={showInvalid ? errorId : undefined}
        />
        {showInvalid && <span className="field-input-status-icon invalid"><IconAlertCircle size={15} /></span>}
        {showValid && <span className="field-input-status-icon valid"><IconCheck size={15} /></span>}
      </div>
      {showInvalid && (
        <span id={errorId} className="field-error-message" role="alert">
          {message}
        </span>
      )}
    </FormField>
  );
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
 * (`GET /job-roles`); choosing "Custom role" creates a new one via the same
 * `POST /job-roles` Shift creation already uses, so there is still exactly
 * one job-role concept, never a second free-text field.
 *
 * No temporary password is collected here — `StaffService.create()` generates
 * one server-side (`generateSecurePassword`), hashed into a column
 * `AuthService.login()` never reads and never exposed to this form. It was
 * never the staff member's real, usable credential anyway: the account is
 * still created PENDING and only activates via the staff member's own
 * password set through the emailed invitation link, then their own first
 * successful login — see `AccountInviteService`/`AuthService.login()`.
 */
export default function CreateUserModal() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('staff');
  const [form, setForm] = useState<FormState>({ ...empty });
  const [error, setError] = useState('');
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['personal', 'employment', 'general']));
  const [step, setStep] = useState(0);
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailServerError, setEmailServerError] = useState<string | null>(null);
  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLDivElement | null>>>({});

  // Staff-only, client-side preview — there's no record id to upload
  // against yet (the new avatar endpoint needs a real Staff id), so the
  // picked file is held here and only sent after `POST /staff` succeeds
  // (see `create`'s `onSuccess` below). Nothing is ever uploaded if the
  // panel is cancelled — zero orphan-file risk, no "upload then maybe
  // discard" complexity needed.
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!avatarFile) { setAvatarPreviewUrl(null); return; }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setRole(detail.role === 'manager' ? 'manager' : 'staff');
      setForm({ ...empty });
      setError('');
      setCreatedInvite(null);
      setOpenSections(new Set(['personal', 'employment', 'general']));
      setEmailTouched(false);
      setEmailServerError(null);
      setAvatarFile(null);
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

  const venues = useQuery({
    queryKey: ['venues', 'for-manager-assignment'],
    queryFn: async () => { const { data } = await api.get<{ data: { id: string; name: string }[] }>('/venues', { params: { status: 'active' } }); return data.data; },
    enabled: open && role === 'manager' && form.managerType === 'venue',
  });

  const create = useMutation({
    mutationFn: async (): Promise<any> => {
      if (role === 'staff') {
        const pounds = parseFloat(form.hourlyRate);
        // "Custom role" is never sent as-is — `CreateStaffDto.jobRoleId` is
        // `@IsUUID()`-validated (there's deliberately no free-text job-role
        // concept in the schema). Reuse the exact same `POST /job-roles`
        // endpoint Shift creation already uses to create a real `JobRole`
        // row first, then send its id — same single source of truth, no
        // schema change, and predefined roles are completely unaffected.
        let resolvedJobRoleId = form.jobRoleId || undefined;
        if (form.jobRoleId === CUSTOM_JOB_ROLE_VALUE) {
          try {
            const { data: newRole } = await api.post('/job-roles', { name: form.customJobRole.trim() });
            resolvedJobRoleId = newRole.id;
          } catch (e: any) {
            if (e?.response?.status === 403) {
              throw new Error("You don't have permission to create new job roles. Ask an admin to add this role first, then select it from the list.");
            }
            throw e;
          }
        }
        return api.post('/staff', {
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone || undefined,
          startDate: form.startDate || undefined,
          defaultPayRatePence: Number.isFinite(pounds) ? Math.round(pounds * 100) : undefined,
          dateOfBirth: form.dateOfBirth || undefined,
          jobRoleId: resolvedJobRoleId,
          emergencyContactName: form.emergencyContactName || undefined,
          emergencyContactRelationship: form.emergencyContactRelationship || undefined,
          emergencyContactPhone: form.emergencyContactPhone || undefined,
          preferredName: form.preferredName || undefined,
          employmentType: form.employmentType || undefined,
          address: form.address || undefined,
          city: form.city || undefined,
          postcode: form.postcode || undefined,
          availableDays: form.availableDays.length > 0 ? form.availableDays : undefined,
          preferredShiftTimes: form.preferredShiftTimes || undefined,
          maxHoursPerWeek: form.maxHoursPerWeek ? Number(form.maxHoursPerWeek) : undefined,
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
      // Best-effort follow-up — the Staff record is already successfully
      // created at this point regardless of how this turns out, so a
      // failure here must never surface as a creation failure (unlike the
      // custom-job-role resolution above, a missing avatar is cosmetic).
      if (role === 'staff' && avatarFile) {
        const form = new FormData();
        form.append('file', avatarFile);
        api.post(`/staff/${data.id}/avatar`, form, { headers: { 'Content-Type': 'multipart/form-data' } })
          .then(() => qc.invalidateQueries({ queryKey: ['staff', data.id] }))
          .catch(() => toast.error('Staff created — photo upload failed. Add one from Staff Detail.'));
      }
      // Preferred flow: the create panel becomes the new record's own Detail
      // panel — the header then reflects real, server-returned data, not
      // this form's local preview state.
      document.dispatchEvent(new CustomEvent('open-user-detail', { detail: { id: data.id, type: role } }));
    },
    onError: (e: any) => {
      // `e?.message` covers the plain `Error` thrown above for a failed
      // custom-job-role creation — that path never has `e.response`, so
      // without this fallback its message would be lost behind the generic
      // "Failed to create." below.
      const message = e?.response?.data?.message ?? e?.message;
      const text = Array.isArray(message) ? message.join(', ') : message ?? 'Failed to create.';
      setError(text);
      // Best-effort: point the wizard back at the step most likely to own
      // this error, rather than leaving the manager stranded on the final
      // step wondering which of the remaining steps the backend is
      // complaining about. Entered data is untouched either way (the
      // request only ever fires from the final step, and failure never
      // resets `form`).
      const lower = text.toLowerCase();
      // Server-side duplicate-email rejection (`ConflictException('A user
      // with this email already exists.')`) — highlight the field itself
      // with the real server message, the same way a client-side format
      // error already does, rather than leaving the manager to spot it
      // only in the plain error paragraph at the bottom of the step.
      setEmailServerError(lower.includes('email') ? text : null);
      if (role === 'staff') {
        if (lower.includes('email')) setStep(STAFF_STEPS.findIndex((s) => s.key === 'general'));
        else if (lower.includes('job role') || lower.includes('jobrole')) setStep(STAFF_STEPS.findIndex((s) => s.key === 'personal'));
      } else if (lower.includes('email')) {
        setOpenSections((s) => new Set([...s, 'general']));
      }
    },
  });

  // Clearing `error` here — not just inside goNext()/goBack() — is what
  // fixes the stale-validation bug: editing any field on the current step
  // immediately drops whatever error was showing, rather than leaving a
  // stale message on screen after the field has already been filled.
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
        { section: 'general', key: 'email', label: 'Email' },
        { section: 'general', key: 'phone', label: 'Mobile number' },
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
  // required-ness is unchanged, only how it's surfaced is).
  const validateStep = (stepIndex: number): { key: FieldKey; message: string } | null => {
    const sectionKey = STAFF_STEPS[stepIndex].key;
    for (const req of REQUIRED.filter((r) => r.section === sectionKey)) {
      if (!String(form[req.key] ?? '').trim()) return { key: req.key, message: `${req.label} is required.` };
    }
    if (sectionKey === 'personal' && form.jobRoleId === CUSTOM_JOB_ROLE_VALUE && !form.customJobRole.trim()) {
      return { key: 'customJobRole', message: 'Enter the custom job role, or choose a different option.' };
    }
    if (sectionKey === 'general' && !isValidEmail(form.email)) {
      setEmailTouched(true);
      return { key: 'email', message: 'Please enter a valid email address.' };
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
    if (!isValidEmail(form.email)) {
      setOpenSections((s) => new Set([...s, 'general']));
      setEmailTouched(true);
      setError('Please enter a valid email address.');
      setTimeout(() => {
        fieldRefs.current.email?.querySelector<HTMLElement>('input, select')?.focus();
        fieldRefs.current.email?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 50);
      return;
    }
    create.mutate();
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
              <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 16px' }}>
                <AvatarUploadButton
                  previewUrl={avatarPreviewUrl}
                  label={previewInitials || '?'}
                  onFileSelected={setAvatarFile}
                />
              </div>
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

              <div className="detail-group">
                <div className="detail-group-title">Employment</div>
                <FormField label="Job role">
                  <select value={form.jobRoleId} onChange={f('jobRoleId')}>
                    <option value="">None</option>
                    {jobRoles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    <option value={CUSTOM_JOB_ROLE_VALUE}>Custom role</option>
                  </select>
                </FormField>
                {form.jobRoleId === CUSTOM_JOB_ROLE_VALUE && (
                  <FormField label="Custom job role" required fieldRef={(el) => { fieldRefs.current.customJobRole = el; }}>
                    <input
                      value={form.customJobRole}
                      onChange={f('customJobRole')}
                      placeholder="Enter job role"
                    />
                  </FormField>
                )}
                <FormField label="Employment type">
                  <select value={form.employmentType} onChange={f('employmentType')}>
                    <option value="">Select employment type</option>
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
              </div>
            </>
          )}

          {STAFF_STEPS[step].key === 'general' && (
            <>
              <EmailField
                value={form.email}
                onChange={(v) => { setError(''); setEmailServerError(null); setForm(p => ({ ...p, email: v })); }}
                touched={emailTouched}
                onTouched={() => setEmailTouched(true)}
                serverError={emailServerError}
                fieldRef={(el) => { fieldRefs.current.email = el; }}
              />
              <FormField label="Mobile number" required fieldRef={(el) => { fieldRefs.current.phone = el; }}>
                <PhoneInput value={form.phone} onChange={(v) => { setError(''); setForm(p => ({ ...p, phone: v })); }} />
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
                  <PhoneInput value={form.emergencyContactPhone} onChange={(v) => { setError(''); setForm(p => ({ ...p, emergencyContactPhone: v })); }} />
                </FormField>
              </div>
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
                  <option value="">Select preferred shift time</option>
                  {SHIFT_TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label="Maximum hours per week">
                <input type="number" min="0" max="168" value={form.maxHoursPerWeek} onChange={f('maxHoursPerWeek')} />
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
            <EmailField
              value={form.email}
              onChange={(v) => { setError(''); setEmailServerError(null); setForm(p => ({ ...p, email: v })); }}
              touched={emailTouched}
              onTouched={() => setEmailTouched(true)}
              serverError={emailServerError}
              fieldRef={(el) => { fieldRefs.current.email = el; }}
            />
            <FormField label="Mobile number" required fieldRef={(el) => { fieldRefs.current.phone = el; }}>
              <PhoneInput value={form.phone} onChange={(v) => { setError(''); setForm(p => ({ ...p, phone: v })); }} />
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
