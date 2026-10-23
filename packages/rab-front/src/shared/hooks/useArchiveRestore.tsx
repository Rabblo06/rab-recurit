import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

import { api } from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import { getApiErrorMessage } from '../lib/apiError';
import { toast } from '../lib/toast';

export type ArchiveAction = 'archive' | 'restore';

/**
 * Wave 5 — the confirm-then-call flow for the server's NAMED archive / restore actions (`POST <resource>/:id/archive`,
 * `POST <resource>/:id/restore`). Used by venues, users (staff and managers) and scheduling (draft shifts). The client
 * never writes a status or `archivedAt`; the server decides (permission, scope, preconditions) and its message is shown
 * verbatim when it refuses (e.g. "Deactivate this staff member before archiving them.").
 */
export function useArchiveRestore<T extends { id: string }>(opts: {
  /** e.g. `(item) => `/venues/${item.id}`` — the action segment is appended. */
  basePath: (item: T) => string;
  noun: string;
  name: (item: T) => string;
  invalidate: QueryKey[];
  /** Extra sentence for the archive confirmation (what stays, what stops). */
  archiveNote?: string;
  onDone?: (item: T, action: ArchiveAction) => void;
}): { request: (item: T, action: ArchiveAction) => void; dialog: ReactNode; pending: boolean } {
  const qc = useQueryClient();
  const [target, setTarget] = useState<{ item: T; action: ArchiveAction } | null>(null);
  const mutation = useMutation({
    mutationFn: ({ item, action }: { item: T; action: ArchiveAction }) => api.post(`${opts.basePath(item)}/${action}`),
    onSuccess: (_res, { item, action }) => {
      for (const key of opts.invalidate) qc.invalidateQueries({ queryKey: key });
      toast.success(`${opts.name(item)} ${action === 'archive' ? 'archived' : 'restored'}.`);
      setTarget(null);
      opts.onDone?.(item, action);
    },
    onError: (error) => {
      toast.error(getApiErrorMessage(error, `Could not ${target?.action ?? 'update'} this ${opts.noun}.`));
      setTarget(null);
    },
  });

  const archiving = target?.action === 'archive';
  const dialog = (
    <ConfirmDialog
      open={!!target}
      title={target ? `${archiving ? 'Archive' : 'Restore'} ${opts.noun}?` : ''}
      description={
        target
          ? archiving
            ? `${opts.name(target.item)} will be hidden from lists and search. History (shifts, attendance, payroll) keeps showing it.${opts.archiveNote ? ` ${opts.archiveNote}` : ''}`
            : `${opts.name(target.item)} will appear in lists and search again.`
          : undefined
      }
      confirmLabel={archiving ? 'Archive' : 'Restore'}
      destructive={archiving}
      loading={mutation.isPending}
      onConfirm={() => target && mutation.mutate(target)}
      onCancel={() => setTarget(null)}
    />
  );
  return { request: (item, action) => setTarget({ item, action }), dialog, pending: mutation.isPending };
}
