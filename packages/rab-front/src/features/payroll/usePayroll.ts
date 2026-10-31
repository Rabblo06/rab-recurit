import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { toast } from '../../shared/lib/toast';
import { pollingOptions } from '../../shared/lib/polling';
import { getApiErrorMessage, isSafeServerMessage } from '../../shared/lib/apiError';
import { bulkMessage, type BulkApproveResult, type PayrollPeriod, type ShiftStatementRef } from './payrollModel';

/** How long the page keeps checking for an Approved Shift Statement the manager just released (dispatch every ~5 s). */
const WATCH_MS = 3 * 60 * 1000;
const POLL_MS = 5000;

export const MESSAGES = {
  approved: 'Payroll approved successfully.',
  generated: 'Approved Shift Statement generated.',
  notVerified: "Payroll can't be approved until verified hours and pay are available.",
  notReady: 'This payroll record is not ready for approval.',
  statementFailed: 'The Approved Shift Statement could not be generated. The approval itself is saved.',
} as const;

/**
 * Data + actions for the Payroll page. Approval, document generation and notification are separate server states, so
 * "Payroll approved successfully." is shown on approval and "Approved Shift Statement generated." only when a later read
 * shows the document really exists (`statement.state === 'available'`).
 */
export function usePayroll(month: string) {
  const queryClient = useQueryClient();
  const [watching, setWatching] = useState<Record<string, number>>({});
  const watchingIds = Object.keys(watching);

  const capabilities = useQuery({
    queryKey: ['auth', 'capabilities'],
    queryFn: async () => (await api.get<Record<string, boolean>>('/auth/capabilities')).data,
    staleTime: 300_000,
  });
  const canApprove = capabilities.data?.['payroll.approve'] === true;

  const period = useQuery({
    queryKey: ['payroll', 'period', month],
    queryFn: async () => (await api.get<PayrollPeriod>('/payroll/period', { params: { month } })).data,
    // Shared polling policy (Phase C1): ±20 % jitter, paused while the tab is hidden with one catch-up when it becomes
    // visible, backoff on failure; only while a just-released statement is being watched (bounded by WATCH_MS).
    ...pollingOptions(() => (watchingIds.length ? POLL_MS : false)),
  });

  // Statement watcher: report the document only once the server says it exists.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (!watchingIds.length || !period.data) return;
    const now = Date.now();
    const next = { ...watching };
    let changed = false;
    for (const id of watchingIds) {
      const row = period.data.rows.find((r) => r.payrollRecordId === id);
      const state = row?.statement?.state;
      if (state === 'available') {
        if (!reported.current.has(id)) { reported.current.add(id); toast.success(MESSAGES.generated); }
        delete next[id]; changed = true;
      } else if (state === 'failed' && !reported.current.has(`failed:${id}`)) {
        reported.current.add(`failed:${id}`);
        toast.warning(MESSAGES.statementFailed);
      } else if (now - (watching[id] ?? now) > WATCH_MS) {
        delete next[id]; changed = true;
      }
    }
    if (changed) setWatching(next);
  }, [period.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const watch = (ids: string[]) => setWatching((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, Date.now()])) }));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll'] });
    void queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };

  const approve = useMutation({
    mutationFn: async (recordId: string) => (await api.post<{ id: string; statement: ShiftStatementRef | null }>(`/payroll/records/${recordId}/approve`)).data,
    onSuccess: (record) => { toast.success(MESSAGES.approved); watch([record.id]); refresh(); },
    onError: (e) => { toast.error(getApiErrorMessage(e, 'Payroll could not be approved. Try again.')); refresh(); },
  });

  const bulkApprove = useMutation({
    mutationFn: async (recordIds: string[]) => (await api.post<BulkApproveResult>('/payroll/records/bulk-approve', { ids: recordIds })).data,
    onError: (e) => { toast.error(getApiErrorMessage(e, 'Payroll could not be approved. Try again.')); refresh(); },
    onSuccess: (result) => { watch(result.approved.map((r) => r.id)); refresh(); },
  });

  /**
   * Approves the eligible record ids among a selection. `skipped` = selected rows that are not approvable (no payroll
   * record yet, already decided, own hours) — never sent, but counted honestly in the message.
   */
  /** True once the server answered (the selection may then be cleared); false when nothing was sent or the call failed. */
  const approveSelection = async (recordIds: string[], skipped: number): Promise<boolean> => {
    if (!recordIds.length) {
      toast.warning(skipped ? MESSAGES.notVerified : MESSAGES.notReady);
      return false;
    }
    const result = await bulkApprove.mutateAsync(recordIds).catch(() => null);
    if (!result) return false; // the error toast is raised by bulkApprove.onError; the selection is kept for a retry
    const blocked = result.blocked.length + skipped;
    const firstReason = result.blocked.map((b) => b.message).find(isSafeServerMessage);
    if (!result.approved.length) toast.warning(firstReason ?? MESSAGES.notReady);
    else if (blocked) toast.warning(bulkMessage(result.approved.length, blocked));
    else toast.success(result.approved.length === 1 ? MESSAGES.approved : bulkMessage(result.approved.length, 0));
    return true;
  };

  const retryStatement = useMutation({
    mutationFn: async (recordId: string) => (await api.post<{ id: string }>(`/payroll/records/${recordId}/statement/retry`)).data,
    onSuccess: (record) => { toast.success('Approved Shift Statement re-queued.'); watch([record.id]); refresh(); },
    onError: (e) => { toast.error(getApiErrorMessage(e, 'The statement could not be re-queued. Try again.')); refresh(); },
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await api.post(`/payroll/records/${id}/reject`, { reason })).data,
    onSuccess: () => { toast.success('Payroll rejected.'); refresh(); },
    // The reject dialog shows the error inline (Payroll.tsx) and stays open with the reason kept: no second, toast copy.
    onError: () => { refresh(); },
  });

  return {
    period,
    canApprove,
    approve,
    approveSelection,
    bulkPending: bulkApprove.isPending,
    reject,
    retryStatement,
    capabilities: capabilities.data ?? {},
    busy: approve.isPending || bulkApprove.isPending || reject.isPending || retryStatement.isPending,
  };
}

/** Opens an Approved Shift Statement PDF through the authorised file route (bytes via the API with the session). */
export async function openShiftStatement(fileId: string, filename: string | null): Promise<void> {
  try {
    const res = await api.get(`/files/${fileId}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data as Blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename ?? 'approved-shift-statement.pdf' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) {
    toast.error(getApiErrorMessage(e, 'The Approved Shift Statement could not be downloaded. Try again.'));
  }
}
