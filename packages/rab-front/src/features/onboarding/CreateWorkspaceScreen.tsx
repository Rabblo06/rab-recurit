import LogoutDialog from '../settings/LogoutDialog';
import AuthLayout from '../auth/AuthLayout';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeSubdomain, isValidSubdomainShape } from '@rab/shared';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { api } from '../../shared/api';
import { useWorkspaceHost, workspaceUrlFor } from '../../shared/lib/workspace-host';
import { toast } from '../../shared/lib/toast';
import { getApiErrorMessage, isSafeServerMessage } from '../../shared/lib/apiError';
import { s, ease, fadeIn } from '../auth/authStyles';
import { captionSwap, staggerContainer, staggerContainerReduced, staggerItem, staggerItemReduced, markSelfServiceWorkspace } from './onboardingMotion';
import AvatarPicker from './AvatarPicker';

interface SubdomainCheck {
  available: boolean;
  normalized: string;
  reserved: boolean;
  suggested?: string;
  alternatives?: string[];
}

interface FieldErrors {
  name?: string;
  subdomain?: string;
}

const DEBOUNCE_MS = 350;

const fieldErrorStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--feedback-error)',
  margin: '-6px 0 10px',
};

export default function CreateWorkspaceScreen() {
  const [leaving, setLeaving] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const reduceMotion = useReducedMotion();
  const container = reduceMotion ? staggerContainerReduced : staggerContainer;
  const item = reduceMotion ? staggerItemReduced : staggerItem;
  // Wave 3 lane H: the preview is the server's own canonical form (`<scheme>://<label>.<WORKSPACE_BASE_DOMAIN>`), and only
  // when the deployment actually routes workspace hosts — never inferred from the browser's hostname.
  const host = useWorkspaceHost();
  const baseDomain = host.workspaceBaseDomain;
  const currentAppAddress = window.location.origin;
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [manuallyEdited, setManuallyEdited] = useState(false);
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Guards against a slow, now-stale availability response overwriting a newer one — see
  // `runAvailabilityCheck`'s own doc comment.
  const checkSeqRef = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const subdomainRef = useRef<HTMLInputElement>(null);

  // While the subdomain hasn't been manually edited, keep it in sync with the name.
  useEffect(() => {
    if (!manuallyEdited) setSubdomain(normalizeSubdomain(name));
  }, [name, manuallyEdited]);

  /**
   * One shared implementation for both the live-typing debounce below and `submit`'s own
   * pre-flight check — callers that only care about keeping `check`/`checking`/`checkFailed`
   * state current pass no args; `submit` passes `{ awaited: true }` to get the resolved result
   * back directly, without a round trip through React state timing.
   *
   * Staleness guard: each call captures a sequence number before awaiting the network request: if
   * a NEWER call has started by the time this one resolves (the user kept typing), this call's
   * result is discarded instead of overwriting the newer one — the classic out-of-order-response
   * race for a debounced live-search field.
   */
  async function runAvailabilityCheck(candidate: string): Promise<{ ok: true; data: SubdomainCheck } | { ok: false }> {
    const seq = ++checkSeqRef.current;
    setChecking(true);
    setCheckFailed(false);
    try {
      const { data } = await api.post<SubdomainCheck>('/manager-workspaces/subdomain/check', { candidate });
      if (checkSeqRef.current !== seq) return { ok: false }; // superseded — a newer check is already in flight or resolved
      setCheck(data);
      setChecking(false);
      return { ok: true, data };
    } catch {
      if (checkSeqRef.current !== seq) return { ok: false };
      setCheckFailed(true);
      setChecking(false);
      return { ok: false };
    }
  }

  useEffect(() => {
    setCheck(null);
    setCheckFailed(false);
    if (!subdomain) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runAvailabilityCheck(subdomain);
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomain]);

  function regenerateFromName() {
    setManuallyEdited(false);
    setSubdomain(normalizeSubdomain(name));
  }

  function applySuggestion(candidate: string) {
    setManuallyEdited(true);
    setSubdomain(candidate);
  }

  /** Server suggestions (work email domain, this name, the organisation's name), already checked for availability. */
  async function suggestAddresses() {
    setSuggesting(true);
    try {
      const { data } = await api.post<{ suggestions: string[] }>('/manager-workspaces/subdomain/suggestions', name.trim() ? { name: name.trim() } : {});
      setSuggestions(Array.isArray(data?.suggestions) ? data.suggestions.filter((c) => isValidSubdomainShape(c)) : []);
    } catch {
      setSuggestions([]);
    } finally {
      setSuggesting(false);
    }
  }

  function validateFields(): FieldErrors {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = 'Workspace name is required.';
    if (!subdomain) errors.subdomain = 'Please enter a subdomain.';
    else if (!isValidSubdomainShape(subdomain)) errors.subdomain = 'Enter a valid subdomain.';
    return errors;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // duplicate-click guard — the button stays clickable while invalid, but never while a real request is in flight
    setError('');

    const errors = validateFields();
    if (errors.name || errors.subdomain) {
      setFieldErrors(errors);
      (errors.name ? nameRef : subdomainRef).current?.focus();
      return;
    }
    setFieldErrors({});

    // Server-side availability must be established for THIS exact value before a creation request
    // is ever sent — never trust a stale/in-flight/unresolved `check`.
    let resolvedCheck = check;
    if (!resolvedCheck || resolvedCheck.normalized !== subdomain) {
      const result = await runAvailabilityCheck(subdomain);
      if (!result.ok) {
        setFieldErrors({ subdomain: "Couldn't check availability. Please try again." });
        subdomainRef.current?.focus();
        return;
      }
      resolvedCheck = result.data;
    }
    if (!resolvedCheck.available) {
      setFieldErrors({ subdomain: resolvedCheck.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.' });
      subdomainRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      let { data: workspace } = await api.post('/manager-workspaces', { name: name.trim(), subdomain });
      if (logoFile) {
        try {
          const form = new FormData();
          form.append('file', logoFile);
          ({ data: workspace } = await api.post('/manager-workspaces/me/logo', form, { headers: { 'Content-Type': 'multipart/form-data' } }));
        } catch {
          toast.error('Workspace created, but the logo could not be uploaded. You can add it later in Settings.');
        }
      }
      // Write the response straight into the cache — see CreateProfileScreen's
      // identical comment for why `invalidateQueries` alone isn't enough here.
      qc.setQueryData(['manager-workspace'], workspace);
      // The one signal `WorkspacePreparationScreen` uses to tell this self-service workspace
      // apart from a P2.9C invite-time-provisioned one, which never visits this screen at all —
      // see that flag's own doc comment for why there's no database column for this instead.
      markSelfServiceWorkspace();
      // replace, not push: this onboarding step is now behind the user — Back should skip over it
      // rather than stacking an extra history entry that `OnboardingRouteGuard` (App.tsx) would
      // then have to catch. The guard is the actual security boundary regardless; this is history
      // hygiene on top of it, not a substitute for it.
      nav('/onboarding/profile', { replace: true });
    } catch (err: any) {
      const body = err?.response?.data;
      if (err?.response?.status === 409 && body?.suggested) {
        setCheck({ available: false, normalized: body.normalized, reserved: false, suggested: body.suggested, alternatives: body.alternatives });
        setFieldErrors({ subdomain: isSafeServerMessage(body.message) ? body.message : 'That subdomain was just taken.' });
        subdomainRef.current?.focus();
      } else {
        setError(getApiErrorMessage(err, 'Could not create your workspace. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
        <h1 style={s.title}>Create your workspace</h1>
        <p style={s.subtitle}>Bring your people and shifts together.</p>

        <motion.form onSubmit={submit} variants={container} initial="initial" animate="animate" noValidate>
          <motion.div variants={item} style={{ marginBottom: 24 }}>
            <AvatarPicker label={name || 'Workspace'} title="Workspace logo" onChange={setLogoFile} />
          </motion.div>

          <motion.div variants={item}>
            <label style={s.label} htmlFor="ws-name">Workspace name</label>
            <input
              id="ws-name"
              ref={nameRef}
              style={{ ...s.input, ...(fieldErrors.name ? { border: '1px solid var(--color-red, #d93025)' } : {}) }}
              value={name}
              onChange={(e) => { setName(e.target.value); if (fieldErrors.name && e.target.value.trim()) setFieldErrors((f) => ({ ...f, name: undefined })); }}
              placeholder="e.g. Acme Staffing"
              autoFocus
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? 'ws-name-error' : undefined}
            />
            {fieldErrors.name && <p id="ws-name-error" role="alert" style={fieldErrorStyle}>{fieldErrors.name}</p>}
          </motion.div>

          <motion.div variants={item}>
            <label style={s.label} htmlFor="ws-subdomain">Workspace address</label>
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <input
                id="ws-subdomain"
                ref={subdomainRef}
                style={{
                  ...s.input,
                  marginBottom: 0,
                  paddingRight: baseDomain ? Math.min(140, 16 + baseDomain.length * 7) : 0,
                  ...(fieldErrors.subdomain ? { border: '1px solid var(--color-red, #d93025)' } : {}),
                }}
                value={subdomain}
                onChange={(e) => {
                  setManuallyEdited(true);
                  setSubdomain(normalizeSubdomain(e.target.value));
                  if (fieldErrors.subdomain) setFieldErrors((f) => ({ ...f, subdomain: undefined }));
                }}
                placeholder="acme-staffing"
                aria-invalid={Boolean(fieldErrors.subdomain)}
                aria-describedby={fieldErrors.subdomain ? 'ws-subdomain-error' : undefined}
              />
              {baseDomain && (
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#999' }}>
                  .{baseDomain}
                </span>
              )}
            </div>
            {fieldErrors.subdomain && <p id="ws-subdomain-error" role="alert" style={{ ...fieldErrorStyle, margin: '2px 0 10px' }}>{fieldErrors.subdomain}</p>}
            {/* The server's canonical form only (useWorkspaceHost), shown only when this deployment routes workspace
                hosts. Otherwise the current application address is named honestly instead of an address that would
                not resolve. Informational: the server builds every real link from the stored label. */}
            {!fieldErrors.subdomain && (
              <p style={{ fontSize: 11, color: '#999', margin: '2px 0 0' }}>
                {subdomain
                  ? workspaceUrlFor(host, subdomain)
                    ? <>Your workspace will be available at <strong>{workspaceUrlFor(host, subdomain)}</strong></>
                    : <>Workspace subdomains aren&apos;t configured for this environment yet — you&apos;ll use the application at <strong>{currentAppAddress}</strong></>
                  : null}
              </p>
            )}
            <button type="button" onClick={() => void suggestAddresses()} disabled={suggesting} style={{ ...s.backBtn, textAlign: 'left', margin: '6px 0 4px' }}>
              {suggesting ? 'Finding available addresses…' : 'Suggest an address'}
            </button>
            {suggestions && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 10px' }} aria-label="Suggested addresses">
                {suggestions.length === 0 ? (
                  <span style={{ fontSize: 11, color: '#999' }}>No suggestions right now — try a different name.</span>
                ) : (
                  suggestions.map((candidate) => (
                    <button
                      type="button"
                      key={candidate}
                      onClick={() => applySuggestion(candidate)}
                      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, border: '1px solid #e5e5e5', background: '#fafafa', cursor: 'pointer' }}
                    >
                      {candidate}
                    </button>
                  ))
                )}
              </div>
            )}
          </motion.div>
          {manuallyEdited && (
            <button type="button" onClick={regenerateFromName} style={{ ...s.backBtn, textAlign: 'left', margin: '0 0 10px' }}>
              ↺ Regenerate from name
            </button>
          )}

          <AnimatePresence mode="wait">
            {subdomain.length >= 3 && !fieldErrors.subdomain && (
              <motion.div
                key={checking ? 'checking' : checkFailed ? 'check-failed' : check?.available ? 'available' : check && !check.available ? 'unavailable' : 'idle'}
                variants={reduceMotion ? undefined : captionSwap}
                initial={reduceMotion ? undefined : 'initial'}
                animate={reduceMotion ? undefined : 'animate'}
                exit={reduceMotion ? undefined : 'exit'}
                style={{ marginBottom: 10, fontSize: 12 }}
              >
                {checking ? (
                  <span style={{ color: '#999' }}>Checking subdomain availability…</span>
                ) : checkFailed ? (
                  <span style={{ color: 'var(--feedback-error)' }}>Couldn't check availability. Please try again.</span>
                ) : check?.available ? (
                  <span style={{ color: 'var(--feedback-success)' }}>✓ {check.normalized} is available</span>
                ) : check && !check.available ? (
                  <div>
                    <span style={{ color: 'var(--feedback-error)' }}>
                      {check.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.'}
                    </span>
                    {check.suggested && (
                      <motion.div
                        variants={reduceMotion ? staggerContainerReduced : staggerContainer}
                        initial="initial"
                        animate="animate"
                        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}
                      >
                        {[check.suggested, ...(check.alternatives ?? [])].map((candidate) => (
                          <motion.button
                            type="button"
                            key={candidate}
                            variants={reduceMotion ? staggerItemReduced : staggerItem}
                            onClick={() => applySuggestion(candidate)}
                            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, border: '1px solid #e5e5e5', background: '#fafafa', cursor: 'pointer' }}
                          >
                            {candidate}
                          </motion.button>
                        ))}
                      </motion.div>
                    )}
                  </div>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>

          {error && <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>{error}</motion.p>}

          <motion.button type="submit" variants={item} style={{ ...s.submitBtn, marginTop: 18, opacity: submitting ? 0.5 : 1 }} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create workspace'}
          </motion.button>
        </motion.form>
      <button type="button" style={s.backBtn} onClick={()=>setLeaving(true)}>← Back to sign in</button>
      <LogoutDialog open={leaving} onClose={()=>setLeaving(false)} />
    </AuthLayout>
  );
}
