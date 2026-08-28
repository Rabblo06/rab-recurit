import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeSubdomain } from '@rab/shared';
import { motion } from 'framer-motion';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import { s, ease, fadeIn } from '../auth/authStyles';
import AvatarPicker from './AvatarPicker';

interface SubdomainCheck {
  available: boolean;
  normalized: string;
  reserved: boolean;
  suggested?: string;
  alternatives?: string[];
}

const DEBOUNCE_MS = 350;

export default function CreateWorkspaceScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [manuallyEdited, setManuallyEdited] = useState(false);
  const [check, setCheck] = useState<SubdomainCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // While the subdomain hasn't been manually edited, keep it in sync with the name.
  useEffect(() => {
    if (!manuallyEdited) setSubdomain(normalizeSubdomain(name));
  }, [name, manuallyEdited]);

  useEffect(() => {
    setCheck(null);
    if (!subdomain) return;
    setChecking(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.post<SubdomainCheck>('/manager-workspaces/subdomain/check', { candidate: subdomain });
        setCheck(data);
      } catch {
        // Availability check failing shouldn't block typing — the real check runs again on submit.
      } finally {
        setChecking(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [subdomain]);

  function regenerateFromName() {
    setManuallyEdited(false);
    setSubdomain(normalizeSubdomain(name));
  }

  function applySuggestion(candidate: string) {
    setManuallyEdited(true);
    setSubdomain(candidate);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !subdomain) return;
    setError('');
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
      nav('/onboarding/profile');
    } catch (err: any) {
      const body = err?.response?.data;
      if (err?.response?.status === 409 && body?.suggested) {
        setCheck({ available: false, normalized: body.normalized, reserved: false, suggested: body.suggested, alternatives: body.alternatives });
        setError(body.message ?? 'That subdomain was just taken.');
      } else {
        setError(body?.message ?? 'Could not create your workspace. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = name.trim().length > 0 && subdomain.length >= 3 && check?.available === true && !submitting;

  return (
    <div style={s.page}>
      <div style={s.overlay} />
      <motion.div style={{ ...s.modal, width: 420 }} {...fadeIn}>
        <p style={s.title}>Create your workspace</p>
        <p style={s.subtitle}>Move work forward across teams and agents.</p>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 16 }}>
            <AvatarPicker label={name || 'Workspace'} onChange={setLogoFile} />
          </div>

          <label style={s.label} htmlFor="ws-name">Workspace name</label>
          <input id="ws-name" style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Issac Recruitment" autoFocus />

          <label style={s.label} htmlFor="ws-subdomain">Subdomain</label>
          <div style={{ position: 'relative', marginBottom: 6 }}>
            <input
              id="ws-subdomain"
              style={{ ...s.input, marginBottom: 0, paddingRight: 60 }}
              value={subdomain}
              onChange={(e) => { setManuallyEdited(true); setSubdomain(normalizeSubdomain(e.target.value)); }}
              placeholder="issac"
            />
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#999' }}>
              .rab.app
            </span>
          </div>
          {manuallyEdited && (
            <button type="button" onClick={regenerateFromName} style={{ ...s.backBtn, textAlign: 'left', margin: '0 0 10px' }}>
              ↺ Regenerate from name
            </button>
          )}

          {subdomain.length >= 3 && (
            <div style={{ marginBottom: 10, fontSize: 12 }}>
              {checking ? (
                <span style={{ color: '#999' }}>Checking availability…</span>
              ) : check?.available ? (
                <span style={{ color: '#166534' }}>✓ {check.normalized} is available</span>
              ) : check && !check.available ? (
                <div>
                  <span style={{ color: '#dc2626' }}>
                    {check.reserved ? 'This subdomain cannot be used.' : 'This subdomain is already taken.'}
                  </span>
                  {check.suggested && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      {[check.suggested, ...(check.alternatives ?? [])].map((candidate) => (
                        <button
                          type="button"
                          key={candidate}
                          onClick={() => applySuggestion(candidate)}
                          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 20, border: '1px solid #e5e5e5', background: '#fafafa', cursor: 'pointer' }}
                        >
                          {candidate}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {error && <motion.p role="alert" style={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={ease}>{error}</motion.p>}

          <button type="submit" style={{ ...s.submitBtn, opacity: canSubmit ? 1 : 0.5 }} disabled={!canSubmit}>
            {submitting ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
