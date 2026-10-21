import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPence } from '@rab/shared';
import { api } from '../../shared/api';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import ModalFrame from '../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../shared/lib/apiError';
import { toast } from '../../shared/lib/toast';
import { EM_DASH, fmtCalendarDate, fmtPeriod } from './payrollModel';

interface PeriodRef { id: string; start: string; end: string; payday: string; note: string | null; needsConfirmation: boolean }
interface PeriodRunSummary { period: PeriodRef; run: { id: string; status: 'prepared' | 'finalised'; records: number; grossPence: number } | null }
interface RunStaffRow {
  staffProfileId: string; staffName: string; staffRef: string | null; records: number; minutes: number; grossPence: number; lateCount: number;
  payslip: { id: string; status: 'processing' | 'available' | 'paid'; version: number; document: { fileId: string; filename: string | null; version: number; uploadedAt: string } | null;
    netPence: number | null; netSource: 'provider_document' | null; paidAt: string | null; paymentReference: string | null } | null;
}
export interface RunView {
  id: string; status: 'prepared' | 'finalised'; period: PeriodRef | null; preparedAt: string; preparedByName: string | null; finalisedAt: string | null; finalisedByName: string | null;
  totals: { records: number; staff: number; minutes: number; grossPence: number; lateCount: number }; staff: RunStaffRow[];
}
interface CalendarView { id: string; year: number; version: number; source: string; notes: string | null; periods: Array<PeriodRef & { days: number }> }
interface ImportReport { periodCount: number; errors: string[]; overlaps: Array<{ first: string; second: string }>; gaps: Array<{ after: string; before: string; days: number }>; nonStandardLengths: Array<{ start: string; end: string; days: number }> }

const hours = (m: number) => `${(m / 60).toFixed(2).replace(/\.00$/, '')} hrs`;

/** "123.45" → 12345 pence without floating point. null when not a valid non-negative amount. */
export function parsePounds(text: string): number | null {
  const m = /^\s*£?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** CSV lines "start,end,payday[,note]" → import periods. */
export function parseCalendarLines(text: string): Array<{ start: string; end: string; payday: string; note?: string }> {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(',');
    const [start = '', end = '', payday = ''] = parts.map((c) => c.trim());
    const note = parts.slice(3).join(',').trim();
    return { start, end, payday, ...(note ? { note } : {}) };
  });
}

async function download(url: string, filename: string) {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const href = URL.createObjectURL(res.data as Blob);
    const a = Object.assign(document.createElement('a'), { href, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  } catch (e) {
    toast.error(getApiErrorMessage(e, 'The file could not be downloaded. Try again.'));
  }
}

/**
 * Payroll runs per agency calendar period (prepare → finalise → export), official provider payslips per staff member
 * (upload PDF, provider-supplied net, explicit "mark paid"), and the agency payment calendar (view, import). Buttons
 * follow /auth/capabilities display hints; the server enforces every rule.
 */
export default function PayrollRunsView({ capabilities }: { capabilities: Record<string, boolean> }) {
  const qc = useQueryClient();
  const can = (flag: string) => capabilities[flag] === true;
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'finalise' } | { kind: 'paid'; staff: RunStaffRow }>(null);
  const [netTarget, setNetTarget] = useState<RunStaffRow | null>(null);

  const calendar = useQuery({ queryKey: ['payroll', 'calendar'], queryFn: async () => (await api.get<{ calendars: CalendarView[]; canManage?: boolean }>('/payroll/calendar')).data });
  const periods = useQuery({ queryKey: ['payroll', 'runs'], queryFn: async () => (await api.get<{ periods: PeriodRunSummary[] }>('/payroll/runs')).data });
  const run = useQuery({ queryKey: ['payroll', 'run', openRunId], enabled: !!openRunId, queryFn: async () => (await api.get<RunView>(`/payroll/runs/${openRunId}`)).data });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['payroll'] }); };
  const onError = (fallback: string) => (e: unknown) => { toast.error(getApiErrorMessage(e, fallback)); refresh(); };

  const prepare = useMutation({
    mutationFn: async (periodId: string) => (await api.post<RunView>('/payroll/runs/prepare', { periodId })).data,
    onSuccess: (r) => { toast.success(`Payroll run prepared: ${r.totals.records} record${r.totals.records === 1 ? '' : 's'}${r.totals.lateCount ? `, ${r.totals.lateCount} late approval${r.totals.lateCount === 1 ? '' : 's'}` : ''}.`); setOpenRunId(r.id); refresh(); },
    onError: onError('The payroll run could not be prepared.'),
  });
  const finalise = useMutation({
    mutationFn: async (runId: string) => (await api.post<RunView>(`/payroll/runs/${runId}/finalise`)).data,
    onSuccess: () => { toast.success('Payroll run finalised.'); setConfirm(null); refresh(); },
    onError: (e) => { setConfirm(null); onError('The payroll run could not be finalised.')(e); },
  });
  const upload = useMutation({
    mutationFn: async ({ runId, staffProfileId, file }: { runId: string; staffProfileId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return (await api.post<RunView>(`/payroll/runs/${runId}/payslips/${staffProfileId}/document`, form)).data;
    },
    onSuccess: () => { toast.success('Payslip uploaded. The staff member has been notified.'); refresh(); },
    onError: onError('The payslip could not be uploaded.'),
  });
  const setNet = useMutation({
    mutationFn: async ({ runId, staffProfileId, netPence }: { runId: string; staffProfileId: string; netPence: number | null }) =>
      (await api.put<RunView>(`/payroll/runs/${runId}/payslips/${staffProfileId}/net`, { netPence })).data,
    onSuccess: () => { toast.success('Net pay recorded from the provider payslip.'); setNetTarget(null); refresh(); },
    onError: onError('Net pay could not be recorded.'),
  });
  const markPaid = useMutation({
    mutationFn: async ({ runId, staffProfileId }: { runId: string; staffProfileId: string }) => (await api.post<RunView>(`/payroll/runs/${runId}/payslips/${staffProfileId}/mark-paid`, {})).data,
    onSuccess: () => { toast.success('Payment confirmed.'); setConfirm(null); refresh(); },
    onError: (e) => { setConfirm(null); onError('The payment could not be confirmed.')(e); },
  });

  const cal = calendar.data?.calendars ?? [];
  const r = run.data;

  return (
    <div className="payroll-runs">
      <section className="payroll-card" aria-label="Payment calendar">
        <header className="payroll-card-head">
          <h2>Payment calendar</h2>
          {/* Only the organisation's Initial Manager imports/replaces the agency calendar (server-computed hint). */}
          {calendar.data?.canManage === true && <button type="button" className="btn btn-outline" onClick={() => setImportOpen(true)}>{cal.length ? 'Import new version' : 'Import calendar'}</button>}
        </header>
        {calendar.isError ? <p role="alert" className="feedback-error">{getApiErrorMessage(calendar.error, "The payment calendar couldn't be loaded.")}</p>
          : calendar.isLoading ? <p className="payroll-muted">Loading…</p>
          : cal.length === 0 ? <p className="payroll-muted">No agency payment calendar is configured. Approved shifts stay unallocated until one is imported.</p>
            : cal.map((c) => (
              <div key={c.id} className="payroll-calendar-summary">
                <div><b>{c.source}</b> · {c.year} · version {c.version} · {c.periods.length} periods</div>
                {c.notes && <p className="payroll-muted">{c.notes}</p>}
                {c.periods.filter((p) => p.note).map((p) => <p key={p.id} className="payroll-muted">{fmtPeriod(p)}: {p.note}</p>)}
              </div>
            ))}
      </section>

      <section className="payroll-card" aria-label="Payroll periods">
        <header className="payroll-card-head"><h2>Payroll runs</h2></header>
        {periods.isError ? <p role="alert" className="feedback-error">{getApiErrorMessage(periods.error, "Payroll runs couldn't be loaded.")}</p> : (
          <div className="payroll-table-scroll">
            <table className="table payroll-table">
              <thead><tr><th>Period</th><th>Payday</th><th>Run</th><th>Records</th><th>Gross</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {(periods.data?.periods ?? []).map(({ period, run: pr }) => (
                  <tr key={period.id} className={openRunId && pr?.id === openRunId ? 'row-selected' : undefined}>
                    <td>{fmtPeriod(period)}</td>
                    <td className="cell-muted">{fmtCalendarDate(period.payday)}</td>
                    <td>{pr ? <span className={`payroll-pill tone-${pr.status === 'finalised' ? 'green' : 'amber'}`}>{pr.status === 'finalised' ? 'Finalised' : 'Prepared'}</span> : <span className="payroll-muted">Not prepared</span>}</td>
                    <td className="cell-muted">{pr?.records ?? EM_DASH}</td>
                    <td className="cell-muted">{pr ? formatPence(pr.grossPence) : EM_DASH}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {can('payroll.calculate') && pr?.status !== 'finalised' && (
                        <button type="button" className="btn btn-outline" disabled={prepare.isPending} aria-label={`Prepare run ${fmtPeriod(period)}`} onClick={() => prepare.mutate(period.id)}>{pr ? 'Update run' : 'Prepare run'}</button>
                      )}{' '}
                      {pr && <button type="button" className="btn btn-outline" aria-label={`Open run ${fmtPeriod(period)}`} onClick={() => setOpenRunId(pr.id)}>Open</button>}
                    </td>
                  </tr>
                ))}
                {periods.data && periods.data.periods.length === 0 && <tr><td colSpan={6} className="payroll-muted payroll-empty-cell">No calendar periods yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {r && (
        <section className="payroll-card" aria-label="Payroll run">
          <header className="payroll-card-head">
            <h2>Run {fmtPeriod(r.period)} · payday {r.period ? fmtCalendarDate(r.period.payday) : EM_DASH}</h2>
            <div className="payroll-record-actions">
              <span className={`payroll-pill tone-${r.status === 'finalised' ? 'green' : 'amber'}`}>{r.status === 'finalised' ? 'Finalised' : 'Prepared'}</span>
              {can('payroll.approve') && r.status === 'prepared' && r.totals.records > 0 && <button type="button" className="btn btn-dark" onClick={() => setConfirm({ kind: 'finalise' })}>Finalise run</button>}
              <button type="button" className="btn btn-outline" onClick={() => void download(`/payroll/runs/${r.id}/export`, `payroll-run-${r.period?.start ?? r.id}.csv`)}>Export CSV</button>
            </div>
          </header>
          <p className="payroll-muted">{r.totals.records} records · {r.totals.staff} staff · {hours(r.totals.minutes)} · {formatPence(r.totals.grossPence)} gross{r.totals.lateCount ? ` · ${r.totals.lateCount} late approval${r.totals.lateCount === 1 ? '' : 's'}` : ''}</p>
          <div className="payroll-table-scroll">
            <table className="table payroll-table">
              <thead><tr><th>Staff</th><th>Shifts</th><th>Hours</th><th>Gross</th><th>Payslip</th><th>Net (provider)</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {r.staff.map((s) => (
                  <tr key={s.staffProfileId}>
                    <td>{s.staffName}{s.staffRef ? <span className="payroll-muted"> · {s.staffRef}</span> : null}{s.lateCount ? <span className="payroll-muted"> · {s.lateCount} late</span> : null}</td>
                    <td className="cell-muted">{s.records}</td>
                    <td className="cell-muted">{hours(s.minutes)}</td>
                    <td className="cell-primary">{formatPence(s.grossPence)}</td>
                    <td>
                      {!s.payslip ? <span className="payroll-muted">Upcoming</span> : (
                        <span className={`payroll-pill tone-${s.payslip.status === 'paid' ? 'green' : s.payslip.status === 'available' ? 'peach' : 'amber'}`}>
                          {s.payslip.status === 'paid' ? 'Paid' : s.payslip.status === 'available' ? 'Available' : 'Processing'}
                        </span>
                      )}
                      {s.payslip?.document && (
                        <button type="button" className="btn-link" onClick={() => void download(`/files/${s.payslip!.document!.fileId}`, s.payslip!.document!.filename ?? 'payslip.pdf')}> v{s.payslip.document.version}</button>
                      )}
                    </td>
                    <td className="cell-muted">{s.payslip?.netPence != null ? `${formatPence(s.payslip.netPence)} (provider)` : EM_DASH}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {r.status === 'finalised' && s.payslip && can('payroll.calculate') && (
                        <UploadButton label={`Upload payslip PDF for ${s.staffName}`} busy={upload.isPending}
                          onFile={(file) => upload.mutate({ runId: r.id, staffProfileId: s.staffProfileId, file })} />
                      )}{' '}
                      {r.status === 'finalised' && s.payslip?.document && can('payroll.calculate') && (
                        <button type="button" className="btn btn-outline" onClick={() => setNetTarget(s)} aria-label={`Record net pay for ${s.staffName}`}>Net</button>
                      )}{' '}
                      {r.status === 'finalised' && s.payslip && !s.payslip.paidAt && can('payroll.mark_paid') && (
                        <button type="button" className="btn btn-outline" onClick={() => setConfirm({ kind: 'paid', staff: s })} aria-label={`Mark paid ${s.staffName}`}>Mark paid</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirm?.kind === 'finalise'}
        title="Finalise payroll run?"
        description="The run is locked: no records can be added or changed, and payslips can then be uploaded. Nothing is paid automatically."
        confirmLabel="Finalise run"
        loading={finalise.isPending}
        onConfirm={() => r && finalise.mutate(r.id)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'paid'}
        title="Confirm payment?"
        description={confirm?.kind === 'paid' ? `Confirm that ${confirm.staff.staffName} has been paid for this period. This is recorded in the audit log and cannot be undone here.` : undefined}
        confirmLabel="Mark paid"
        loading={markPaid.isPending}
        onConfirm={() => confirm?.kind === 'paid' && r && markPaid.mutate({ runId: r.id, staffProfileId: confirm.staff.staffProfileId })}
        onCancel={() => setConfirm(null)}
      />
      {netTarget && r && <NetDialog staff={netTarget} busy={setNet.isPending} onCancel={() => setNetTarget(null)}
        onSave={(netPence) => setNet.mutate({ runId: r.id, staffProfileId: netTarget.staffProfileId, netPence })} />}
      {importOpen && <ImportCalendarDialog onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); refresh(); }} />}
    </div>
  );
}

function UploadButton({ label, busy, onFile }: { label: string; busy: boolean; onFile: (file: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="application/pdf,.pdf" hidden aria-label={label}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <button type="button" className="btn btn-outline" disabled={busy} onClick={() => ref.current?.click()}>Upload PDF</button>
    </>
  );
}

function NetDialog({ staff, busy, onSave, onCancel }: { staff: RunStaffRow; busy: boolean; onSave: (netPence: number | null) => void; onCancel: () => void }) {
  const [text, setText] = useState(staff.payslip?.netPence != null ? (staff.payslip.netPence / 100).toFixed(2) : '');
  const pence = text.trim() === '' ? null : parsePounds(text);
  const invalid = text.trim() !== '' && pence === null;
  return (
    <ModalFrame open onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'net-title' }}>
      <h3 id="net-title">Net pay for {staff.staffName}</h3>
      <p className="payroll-muted">Copy the net pay from the provider's official payslip. Crewflow never calculates tax, National Insurance or net pay. Leave empty to clear.</p>
      <div className="field"><label htmlFor="net-input">Net pay (£, from the provider payslip)</label>
        <input id="net-input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 412.50" /></div>
      {invalid && <p role="alert" className="feedback-error">Enter an amount like 412.50.</p>}
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-dark" disabled={busy || invalid} onClick={() => onSave(pence)}>Save</button>
      </div>
    </ModalFrame>
  );
}

function ImportCalendarDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const body = (dryRun: boolean) => ({ year: Number(year), source: source.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}), dryRun, periods: parseCalendarLines(lines) });
  const send = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await api.post<{ applied: boolean; report: ImportReport }>('/payroll/calendar/import', body(dryRun));
      setReport(res.data.report);
      if (res.data.applied) { toast.success('Payment calendar imported.'); onImported(); }
    } catch (e) {
      const rep = (e as { response?: { data?: { report?: ImportReport } } })?.response?.data?.report;
      if (rep) setReport(rep);
      toast.error(getApiErrorMessage(e, 'The calendar could not be imported.'));
    } finally {
      setBusy(false);
    }
  };
  const blocking = !!report && (report.errors.length > 0 || report.overlaps.length > 0);
  return (
    <ModalFrame open onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'import-title' }}>
      <h3 id="import-title">Import payment calendar</h3>
      <div className="field"><label htmlFor="cal-year">Year</label><input id="cal-year" inputMode="numeric" value={year} onChange={(e) => { setYear(e.target.value); setReport(null); }} /></div>
      <div className="field"><label htmlFor="cal-source">Source</label><input id="cal-source" value={source} onChange={(e) => { setSource(e.target.value); setReport(null); }} placeholder="e.g. Adolphus Recruitment Calendar of Payment 2026" /></div>
      <div className="field"><label htmlFor="cal-notes">Guidance notes (optional)</label><input id="cal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="field"><label htmlFor="cal-lines">Periods (one per line: start,end,payday[,note])</label>
        <textarea id="cal-lines" rows={8} value={lines} onChange={(e) => { setLines(e.target.value); setReport(null); }} placeholder="2026-10-12,2026-10-25,2026-11-04" /></div>
      {report && (
        <div role="status" className="payroll-import-report">
          <p>{report.periodCount} periods checked.</p>
          {report.errors.map((x) => <p key={x} className="feedback-error">{x}</p>)}
          {report.overlaps.map((o) => <p key={o.first + o.second} className="feedback-error">Overlap: {o.first} and {o.second}</p>)}
          {report.gaps.map((g) => <p key={g.after}>Gap of {g.days} day{g.days === 1 ? '' : 's'} after {g.after}</p>)}
          {report.nonStandardLengths.map((n) => <p key={n.start}>{n.start} – {n.end}: {n.days} days (not 14)</p>)}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-outline" onClick={() => void send(true)} disabled={busy || !source.trim() || !lines.trim()}>Validate</button>
        <button className="btn btn-dark" onClick={() => void send(false)} disabled={busy || !report || blocking}>Import</button>
      </div>
    </ModalFrame>
  );
}
