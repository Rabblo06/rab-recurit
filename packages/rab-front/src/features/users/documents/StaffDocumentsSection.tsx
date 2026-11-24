import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  REQUIRABLE_STAFF_DOCUMENT_TYPES,
  STAFF_DOCUMENT_TYPE_LABELS,
  STAFF_DOCUMENT_TYPES,
  type StaffDocumentTypeType,
} from '@rab/shared';
import { api } from '../../../shared/api';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';
import {
  uploadHint,
  validateUploadFile,
  type UploadRule,
} from '../../../shared/lib/upload';
import './staff-documents.css';

/** Mirrors `StaffDocumentView` (server modules/staff/services/staff-document.service.ts). */
export interface StaffDocumentView {
  id: string;
  documentType: string;
  documentTypeLabel: string;
  issuedOn: string | null;
  expiresOn: string | null;
  status: 'pending' | 'verified' | 'rejected' | 'revoked';
  scanStatus: 'not_scanned' | 'clean' | 'infected';
  fileId: string | null;
  uploadedAt: string;
  uploadedBySelf: boolean;
  verifiedAt: string | null;
  rejectionReason: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  expired: boolean;
  daysUntilExpiry: number | null;
}
interface DocumentsResponse {
  documents: StaffDocumentView[];
  requiredTypes: string[];
}

/** STAFF_DOCUMENT: PDF / PNG / JPEG, 10 MB (server: STAFF_DOCUMENT_MAX_BYTES + magic-byte sniffing; the server decides). */
export const STAFF_DOCUMENT_RULE: UploadRule = {
  noun: 'document',
  mimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'],
  extensions: ['pdf', 'png', 'jpg', 'jpeg'],
  typesLabel: 'PDF, PNG or JPG file',
  maxBytes: 10 * 1024 * 1024,
};

const STATUS_LABEL: Record<StaffDocumentView['status'], string> = {
  pending: 'Awaiting review',
  verified: 'Verified',
  rejected: 'Rejected',
  revoked: 'Revoked',
};

function expiryText(d: StaffDocumentView): {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'none';
} {
  if (!d.expiresOn) return { text: 'No expiry date', tone: 'none' };
  const date = new Date(`${d.expiresOn}T00:00:00Z`).toLocaleDateString(
    'en-GB',
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  );
  if (d.expired) return { text: `Expired ${date}`, tone: 'bad' };
  if (d.daysUntilExpiry === 0)
    return { text: `Expires today (${date})`, tone: 'bad' };
  if (d.daysUntilExpiry !== null && d.daysUntilExpiry <= 30)
    return {
      text: `Expires in ${d.daysUntilExpiry} day${d.daysUntilExpiry === 1 ? '' : 's'} (${date})`,
      tone: 'warn',
    };
  return { text: `Expires ${date}`, tone: 'ok' };
}

async function downloadFile(fileId: string, filename: string) {
  try {
    const res = await api.get(`/files/${fileId}/download`, {
      responseType: 'blob',
    });
    const href = URL.createObjectURL(res.data as Blob);
    const a = Object.assign(document.createElement('a'), {
      href,
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  } catch (e) {
    toast.error(
      getApiErrorMessage(
        e,
        'The document could not be downloaded. It may have been revoked.',
      ),
    );
  }
}

/**
 * Staff detail → Documents (Lane D). A manager sees one staff member's documents, uploads one on their behalf, and verifies,
 * rejects or revokes (named actions; the server re-checks everything). A file stays hidden — no download, no verify — until
 * a real virus scanner has marked it clean (owner-recommended rule). Expired / expiring documents are highlighted; a
 * required type that has expired blocks new offers (server reason code STAFF_REQUIRED_DOCUMENT_EXPIRED).
 */
export default function StaffDocumentsSection({
  staffId,
  staffName,
}: {
  staffId: string;
  staffName: string;
}) {
  const qc = useQueryClient();
  const key = ['staff', staffId, 'documents'];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await api.get<DocumentsResponse>(`/staff/${staffId}/documents`)).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const [documentType, setDocumentType] =
    useState<StaffDocumentTypeType>('right_to_work');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const upload = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('documentType', documentType);
      if (issuedOn) form.append('issuedOn', issuedOn);
      if (expiresOn) form.append('expiresOn', expiresOn);
      form.append('file', file!);
      return (
        await api.post<StaffDocumentView>(`/staff/${staffId}/documents`, form, {
          timeout: 120_000,
        })
      ).data;
    },
    onSuccess: () => {
      toast.success('Document uploaded.');
      setFile(null);
      setIssuedOn('');
      setExpiresOn('');
      if (fileInput.current) fileInput.current.value = '';
      void refresh();
    },
    onError: (e) =>
      toast.error(getApiErrorMessage(e, 'The document could not be uploaded.')),
  });

  const decide = useMutation({
    mutationFn: async (v: {
      id: string;
      action: 'verify' | 'reject' | 'revoke';
      reason?: string;
    }) =>
      (
        await api.post(
          `/staff/${staffId}/documents/${v.id}/${v.action}`,
          v.reason ? { reason: v.reason } : {},
        )
      ).data,
    onSuccess: (_d, v) => {
      toast.success(
        v.action === 'verify'
          ? 'Document verified.'
          : v.action === 'reject'
            ? 'Document rejected.'
            : 'Document revoked.',
      );
      setRejecting(null);
      setReason('');
      void refresh();
    },
    onError: (e) =>
      toast.error(getApiErrorMessage(e, 'That change could not be saved.')),
  });

  const pickFile = (f: File | null) => {
    setFile(null);
    setFileError(null);
    if (!f) return;
    const rejection = validateUploadFile(f, STAFF_DOCUMENT_RULE);
    if (rejection) setFileError(rejection.message);
    else setFile(f);
  };

  if (isLoading) return <p className="staff-docs__muted">Loading documents…</p>;
  if (error)
    return (
      <p className="feedback-error" role="alert">
        {getApiErrorMessage(error, 'Documents are not available.')}
      </p>
    );

  const documents = data?.documents ?? [];
  const required = data?.requiredTypes ?? [];
  const blockedTypes = required.filter((t) => {
    const held = documents.filter(
      (d) =>
        d.documentType === t &&
        (d.status === 'pending' || d.status === 'verified'),
    );
    return held.length > 0 && held.every((d) => d.expired);
  });

  return (
    <section className="staff-docs" aria-label={`Documents of ${staffName}`}>
      {required.length > 0 && (
        <p className="staff-docs__required">
          Required:{' '}
          {required
            .map(
              (t) =>
                STAFF_DOCUMENT_TYPE_LABELS[t as StaffDocumentTypeType] ?? t,
            )
            .join(', ')}
        </p>
      )}
      {blockedTypes.length > 0 && (
        <p className="feedback-error" role="alert">
          New offers are blocked:{' '}
          {blockedTypes
            .map(
              (t) =>
                STAFF_DOCUMENT_TYPE_LABELS[t as StaffDocumentTypeType] ?? t,
            )
            .join(', ')}{' '}
          expired. Upload a current document.
        </p>
      )}

      {documents.length === 0 ? (
        <p className="staff-docs__muted">No documents yet.</p>
      ) : (
        <ul className="staff-docs__list">
          {documents.map((d) => {
            const expiry = expiryText(d);
            return (
              <li
                key={d.id}
                className="staff-docs__item"
                data-testid={`staff-doc-${d.id}`}
              >
                <div className="staff-docs__row">
                  <strong>{d.documentTypeLabel}</strong>
                  <span
                    className={`staff-docs__chip staff-docs__chip--${d.status}`}
                  >
                    {STATUS_LABEL[d.status]}
                  </span>
                  {d.status !== 'revoked' && (
                    <span
                      className={`staff-docs__expiry staff-docs__expiry--${expiry.tone}`}
                    >
                      {expiry.text}
                    </span>
                  )}
                </div>
                <div className="staff-docs__meta">
                  Uploaded {new Date(d.uploadedAt).toLocaleDateString('en-GB')}{' '}
                  {d.uploadedBySelf ? 'by the staff member' : 'by a manager'}
                  {d.scanStatus === 'not_scanned' && d.status !== 'revoked' && (
                    <span>
                      {' '}
                      · Awaiting virus scan (hidden until scanned clean)
                    </span>
                  )}
                  {d.rejectionReason && (
                    <span> · Rejected: {d.rejectionReason}</span>
                  )}
                  {d.revocationReason && (
                    <span> · Revoked: {d.revocationReason}</span>
                  )}
                </div>
                <div className="staff-docs__actions">
                  {d.fileId && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() =>
                        void downloadFile(
                          d.fileId!,
                          `${d.documentType}-${d.id.slice(0, 8)}`,
                        )
                      }
                    >
                      Download
                    </button>
                  )}
                  {d.status === 'pending' && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={d.scanStatus !== 'clean' || decide.isPending}
                      title={
                        d.scanStatus !== 'clean'
                          ? 'Available once the file is scanned clean'
                          : undefined
                      }
                      onClick={() =>
                        decide.mutate({ id: d.id, action: 'verify' })
                      }
                    >
                      Verify
                    </button>
                  )}
                  {d.status === 'pending' && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={decide.isPending}
                      onClick={() => setRejecting(d.id)}
                    >
                      Reject
                    </button>
                  )}
                  {(d.status === 'pending' || d.status === 'verified') && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ id: d.id, action: 'revoke' })
                      }
                    >
                      Revoke
                    </button>
                  )}
                </div>
                {rejecting === d.id && (
                  <form
                    className="staff-docs__reject"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (reason.trim().length >= 3)
                        decide.mutate({
                          id: d.id,
                          action: 'reject',
                          reason: reason.trim(),
                        });
                    }}
                  >
                    <label>
                      Reason
                      <input
                        value={reason}
                        maxLength={500}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. the scan is unreadable"
                      />
                    </label>
                    <button
                      type="submit"
                      className="btn"
                      disabled={reason.trim().length < 3 || decide.isPending}
                    >
                      Reject document
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setRejecting(null)}
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="staff-docs__upload"
        onSubmit={(e) => {
          e.preventDefault();
          if (file && !upload.isPending) upload.mutate();
        }}
      >
        <h4>Upload a document</h4>
        <label>
          Type
          <select
            value={documentType}
            onChange={(e) =>
              setDocumentType(e.target.value as StaffDocumentTypeType)
            }
          >
            {STAFF_DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {STAFF_DOCUMENT_TYPE_LABELS[t]}
                {REQUIRABLE_STAFF_DOCUMENT_TYPES.includes(t) &&
                required.includes(t)
                  ? ' (required)'
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Issued on
          <input
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
          />
        </label>
        <label>
          Expires on
          <input
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
        </label>
        <label>
          File
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <span className="staff-docs__muted">
          {uploadHint(STAFF_DOCUMENT_RULE)}
        </span>
        {fileError && (
          <p className="feedback-error" role="alert">
            {fileError}
          </p>
        )}
        <button
          type="submit"
          className="btn"
          disabled={!file || upload.isPending}
        >
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </button>
      </form>
    </section>
  );
}
