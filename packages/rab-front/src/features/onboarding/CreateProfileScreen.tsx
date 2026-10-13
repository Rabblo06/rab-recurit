import LogoutDialog from '../settings/LogoutDialog';
import AuthLayout from '../auth/AuthLayout';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api } from '../../shared/api';
import { s, ease, fadeIn } from '../auth/authStyles';
import { staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced, clearPendingWelcome, markPendingManagerWelcome } from './onboardingMotion';
import AvatarPicker from './AvatarPicker';

interface FieldErrors {
  firstName?: string;
  lastName?: string;
}

const fieldErrorStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-red, #d93025)',
  margin: '-6px 0 10px',
};

export default function CreateProfileScreen() {
  const [leaving, setLeaving] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const firstNameRef = useRef<HTMLInputElement>(null);
  const lastNameRef = useRef<HTMLInputElement>(null);

  function validateFields(): FieldErrors {
    const errors: FieldErrors = {};
    if (!firstName.trim()) errors.firstName = 'First name is required.';
    if (!lastName.trim()) errors.lastName = 'Last name is required.';
    return errors;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // duplicate-click guard — the button stays clickable while invalid, but never while a real request is in flight
    setError('');

    const errors = validateFields();
    if (errors.firstName || errors.lastName) {
      setFieldErrors(errors);
      (errors.firstName ? firstNameRef : lastNameRef).current?.focus();
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      let profileRes = await api.patch('/profile', { firstName: firstName.trim(), lastName: lastName.trim(), jobTitle: jobTitle.trim() || undefined });
      if (avatarFile) {
        const form = new FormData();
        form.append('file', avatarFile);
        profileRes = await api.post('/profile/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      const { data: workspace } = await api.post('/manager-workspaces/me/complete-onboarding');
      // Write the responses we already have straight into the cache instead
      // of invalidating and hoping a refetch happens — nothing observes
      // `['manager-workspace']`/`['profile']` while on this route (OnboardingGate
      // isn't mounted here), so `invalidateQueries` alone wouldn't actually
      // refresh the cache before `nav('/')` fires, leaving OnboardingGate to
      // read a stale pre-onboarding `null` on its next mount and bounce back
      // to Create Workspace. Setting the data directly makes it correct the
      // instant navigation happens, no round trip needed.
      qc.setQueryData(['profile'], profileRes.data);
      qc.setQueryData(['manager-workspace'], workspace);
      // A Manager gets its welcome from `WorkspacePreparationScreen` below, not `Layout.tsx`'s
      // generic CEO/Super-Admin one — clear the flag `ActivateAccount.tsx` set so Layout never
      // shows a second, redundant welcome overlay once this flow lands on '/'.
      clearPendingWelcome();
      markPendingManagerWelcome(workspace.id);
      // `WorkspacePreparationScreen` reads the same `['manager-workspace']` cache entry just
      // written above, so its very first render already has today's real `schemaStatus` — no
      // extra round trip before it can decide whether to wait or go straight to the welcome
      // transition.
      // replace, not push — same reasoning as CreateWorkspaceScreen's identical comment.
      nav('/onboarding/preparing', { replace: true });
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Could not save your profile. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
        <h1 style={s.title}>Create your profile</h1>
        <p style={s.subtitle}>Let your team know who you are.</p>

        <motion.form onSubmit={submit} variants={container} initial="initial" animate="animate" noValidate>
          <motion.div variants={item} style={{ marginBottom: 24 }}>
            <AvatarPicker label={firstName || '·'} title="Profile picture" onChange={setAvatarFile} />
          </motion.div>

          <motion.div variants={item}>
            <label style={s.label} htmlFor="p-first">First name</label>
            <input
              id="p-first"
              placeholder="First name"
              ref={firstNameRef}
              style={{ ...s.input, ...(fieldErrors.firstName ? { border: '1px solid var(--color-red, #d93025)' } : {}) }}
              value={firstName}
              onChange={(e) => { setFirstName(e.target.value); if (fieldErrors.firstName && e.target.value.trim()) setFieldErrors((f) => ({ ...f, firstName: undefined })); }}
              autoFocus
              aria-invalid={Boolean(fieldErrors.firstName)}
              aria-describedby={fieldErrors.firstName ? 'p-first-error' : undefined}
            />
            {fieldErrors.firstName && <p id="p-first-error" role="alert" style={fieldErrorStyle}>{fieldErrors.firstName}</p>}
          </motion.div>

          <motion.div variants={item}>
            <label style={s.label} htmlFor="p-last">Last name</label>
            <input
              id="p-last"
              placeholder="Last name"
              ref={lastNameRef}
              style={{ ...s.input, ...(fieldErrors.lastName ? { border: '1px solid var(--color-red, #d93025)' } : {}) }}
              value={lastName}
              onChange={(e) => { setLastName(e.target.value); if (fieldErrors.lastName && e.target.value.trim()) setFieldErrors((f) => ({ ...f, lastName: undefined })); }}
              aria-invalid={Boolean(fieldErrors.lastName)}
              aria-describedby={fieldErrors.lastName ? 'p-last-error' : undefined}
            />
            {fieldErrors.lastName && <p id="p-last-error" role="alert" style={fieldErrorStyle}>{fieldErrors.lastName}</p>}
          </motion.div>

          <motion.div variants={item}>
            <label style={s.label} htmlFor="p-title">Job title <span className="field-optional">(optional)</span></label>
            <input id="p-title" style={s.input} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Operations manager" />
          </motion.div>

          {error && <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>{error}</motion.p>}

          <motion.button type="submit" variants={item} style={{ ...s.submitBtn, opacity: submitting ? 0.5 : 1 }} disabled={submitting}>
            {submitting ? 'Saving…' : 'Complete setup'}
          </motion.button>
        </motion.form>
      <button type="button" style={s.backBtn} onClick={()=>setLeaving(true)}>← Back to sign in</button>
      <LogoutDialog open={leaving} onClose={()=>setLeaving(false)} />
    </AuthLayout>
  );
}
