import { useEffect, useRef, useState } from 'react';
import { IconLock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../../shared/api';
import { getApiFieldErrors } from '../../../shared/lib/apiError';
import { useCurrentProfile, type CurrentProfile } from '../../../shared/hooks/useCurrentProfile';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { applyConfirmedProfile } from './profile-cache';
import { clearProfileDraft, getProfileDraft, setProfileDraft } from './profile-draft';
import AvatarUpload from './AvatarUpload';
import DevicesList from './DevicesList';
import { FormSkeleton } from '../../../shared/components/LoadingState';

export default function ProfilePage() {
  const qc = useQueryClient();
  const { data: profile, isLoading } = useCurrentProfile();

  // Seeded once, synchronously, from `profile-draft.ts`'s identity-scoped store — see that
  // file's own doc comment for the remount this closes: a draft only comes back here if it was
  // written under the EXACT SAME identity (userId + the existing P0 generation epoch) this
  // mount is running under; a genuine identity transition always starts both of these from
  // their "nothing yet" defaults instead.
  const [firstName, setFirstNameState] = useState(() => getProfileDraft()?.firstName ?? '');
  const [lastName, setLastNameState] = useState(() => getProfileDraft()?.lastName ?? '');
  const [jobTitle, setJobTitleState] = useState(() => getProfileDraft()?.jobTitle ?? '');
  // `touched` is the "has the user started editing" signal the reseed effect below gates on —
  // deliberately NOT derived from "does the local value differ from the CURRENT profile", which
  // would wrongly read as "dirty" the instant an unrelated background refetch changes `profile`
  // out from under an untouched form (confirmed directly: a same-user background refetch with
  // nothing typed must still reseed, see this file's own spec). Seeded `true` when a draft was
  // restored — a remount, mid-edit, is exactly as "touched" as the instance before it.
  const [touched, setTouched] = useState(() => getProfileDraft() !== null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const firstRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLInputElement>(null);
  const jobRef = useRef<HTMLInputElement>(null);
  const inputRefs = { firstName: firstRef, lastName: lastRef, jobTitle: jobRef };

  const dirty =
    touched && profile
      ? firstName !== profile.firstName || lastName !== profile.lastName || jobTitle !== (profile.jobTitle ?? '')
      : false;

  useEffect(() => {
    // Same-identity rule: a background `profile` update (first real load, or any later
    // refetch) reseeds the form ONLY while it's untouched. An in-progress edit is never
    // clobbered — whether `profile` changed because of a genuine refetch, or because this very
    // component instance is a remount of the one the user was just typing into (the draft
    // restored above already marked it `touched`, so this correctly no-ops on that remount's
    // first run too).
    if (profile && !touched) {
      setFirstNameState(profile.firstName);
      setLastNameState(profile.lastName);
      setJobTitleState(profile.jobTitle ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: fires on `profile`
    // change, reads the latest `touched` via closure, not on every keystroke.
  }, [profile]);

  function clearFieldError(field: ProfileField): void {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }
  /** Shows the given field errors (replacing any earlier ones) and focuses the first invalid field. True if any. */
  function showFieldErrors(errors: Partial<Record<ProfileField, string>>): boolean {
    setFieldErrors(errors);
    const first = PROFILE_FIELDS.find((f) => errors[f]);
    if (first) inputRefs[first].current?.focus();
    return first !== undefined;
  }

  function setFirstName(value: string): void {
    clearFieldError('firstName');
    setFirstNameState(value);
    setTouched(true);
    setProfileDraft({ firstName: value, lastName, jobTitle });
  }
  function setLastName(value: string): void {
    clearFieldError('lastName');
    setLastNameState(value);
    setTouched(true);
    setProfileDraft({ firstName, lastName: value, jobTitle });
  }
  function setJobTitle(value: string): void {
    clearFieldError('jobTitle');
    setJobTitleState(value);
    setTouched(true);
    setProfileDraft({ firstName, lastName, jobTitle: value });
  }

  // PATCH /profile answers with the saved profile. Success is announced only after that answer; on failure every typed
  // value stays (nothing here resets the form) and a server validation error is shown under its field.
  const save = useFeedbackMutation<CurrentProfile, ProfileValues>({
    mutationFn: async (values) => (await api.patch<CurrentProfile>('/profile', values)).data,
    successMessage: 'Profile updated.',
    errorFeedback: (error) =>
      showFieldErrors(getApiFieldErrors(error, FIELD_MESSAGES))
        ? { fallback: CHECK_FIELDS, messages: { validation: CHECK_FIELDS } }
        : { fallback: SAVE_FAILED },
    onSuccess: (saved) => {
      setTouched(false);
      setFieldErrors({});
      clearProfileDraft();
      applyConfirmedProfile(qc, saved);
    },
  });

  function submitProfile() {
    // The same rule as the server's UpdateProfileDto (@MinLength(1) on both names), checked first so an incomplete form
    // never makes a round trip. The server still validates, and its answer is mapped back onto the fields.
    const local: Partial<Record<ProfileField, string>> = {};
    if (firstName.length === 0) local.firstName = FIELD_MESSAGES.firstName;
    if (lastName.length === 0) local.lastName = FIELD_MESSAGES.lastName;
    if (showFieldErrors(local)) return;
    save.submit({ firstName, lastName, jobTitle });
  }

  // POST /auth/forgot-password answers 204 whether or not a mail is sent (enumeration-safe); the link goes to this
  // account's own address. 429 (rate limit) and 5xx come back as errors.
  const setPassword = useFeedbackMutation<unknown, string>({
    mutationFn: (email) => api.post('/auth/forgot-password', { email }),
    successMessage: 'Check your email for a link to set a new password.',
    errorFeedback: { fallback: PASSWORD_MAIL_FAILED },
  });

  if (isLoading) {
    return <FormSkeleton sections={4} />;
  }

  return (
    <div className="settings-page profile-settings">
      <div className="settings-page-heading"><h2>Profile</h2><p>Your personal details and how you appear to others.</p></div>
      <div className="profile-settings-grid">
        <div>
          <section className="settings-section profile-picture-card"><AvatarUpload avatarKey={profile?.avatarKey ?? null} firstName={profile?.firstName} /></section>
          <section className="settings-section personal-details-card"><h3>Personal details</h3>
            <form noValidate onSubmit={(e) => { e.preventDefault(); if (dirty) submitProfile(); }}>
            <div className="form-grid"><div className="field"><label htmlFor="profile-first">First name</label><input ref={firstRef} id="profile-first" value={firstName} onChange={e => setFirstName(e.target.value)} {...fieldA11y('firstName', fieldErrors)} /><FieldError field="firstName" errors={fieldErrors} /></div>
              <div className="field"><label htmlFor="profile-last">Last name</label><input ref={lastRef} id="profile-last" value={lastName} onChange={e => setLastName(e.target.value)} {...fieldA11y('lastName', fieldErrors)} /><FieldError field="lastName" errors={fieldErrors} /></div></div>
            <div className="field"><label htmlFor="profile-job">Job title</label><input ref={jobRef} id="profile-job" value={jobTitle} onChange={e => setJobTitle(e.target.value)} placeholder="e.g. Operations manager" {...fieldA11y('jobTitle', fieldErrors)} /><FieldError field="jobTitle" errors={fieldErrors} /></div>
            <div className="settings-save-row"><button type="submit" className="btn btn-dark" disabled={!dirty || save.busy} aria-busy={save.busy || undefined}>{save.busy ? 'Saving…' : 'Save changes'}</button></div>
            </form>
          </section>
          <section className="settings-section"><h3>Email address</h3><p>The email associated with your account.</p><div className="field"><input aria-label="Email address" id="profile-email" value={profile?.email ?? ''} disabled /></div></section>
        </div>
        <div>
          <section className="settings-section password-access-card"><IconLock aria-hidden="true" className="settings-security-icon" size={22} stroke={1.5} /><h3>Password &amp; access</h3><p>Receive an email with a secure link to set your account password.</p><button type="button" className="btn btn-outline" onClick={() => { if (profile) setPassword.submit(profile.email); }} disabled={!profile || setPassword.busy} aria-busy={setPassword.busy || undefined}>{setPassword.busy ? 'Sending…' : 'Set password'}</button></section>
          <section className="settings-section devices-card"><h3>Devices</h3><p>Devices with an active session on your account.</p><DevicesList /></section>
          <aside className="profile-sharing-note">Your profile is shared with your workspace. Keep your details up to date so your team can reach you.</aside>
        </div>
      </div>
    </div>
  );
}

type ProfileField = 'firstName' | 'lastName' | 'jobTitle';
type ProfileValues = Record<ProfileField, string>;
const PROFILE_FIELDS: ProfileField[] = ['firstName', 'lastName', 'jobTitle'];
/** Our own copy for each field: server validation text is matched to these by property name, never shown raw. */
const FIELD_MESSAGES: Record<ProfileField, string> = {
  firstName: 'Enter your first name.',
  lastName: 'Enter your last name.',
  jobTitle: 'Enter a valid job title.',
};
const CHECK_FIELDS = 'Your profile was not saved. Check the highlighted fields.';
const SAVE_FAILED = 'Could not save your profile. Please try again.';
const PASSWORD_MAIL_FAILED = 'Could not send the password email. Please try again.';

function fieldA11y(field: ProfileField, errors: Partial<Record<ProfileField, string>>) {
  return errors[field] ? { 'aria-invalid': true as const, 'aria-describedby': `profile-${field}-error` } : {};
}

/** Under-the-field message. Not its own live region: focus moves to the first invalid field, which reads it via aria-describedby. */
function FieldError({ field, errors }: { field: ProfileField; errors: Partial<Record<ProfileField, string>> }) {
  const message = errors[field];
  return message ? <span id={`profile-${field}-error`} className="field-error-message">{message}</span> : null;
}
