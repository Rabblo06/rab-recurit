import { StaffDocumentStatus, StaffDocumentStatusType } from '../types';
import { TransitionTable } from './assert-transition';

/**
 * Staff document verification (StaffDocumentSchema1786722300000). A pending upload is verified or rejected by a manager; a
 * pending or verified document can be revoked (withdrawn, wrong person, superseded). Rejected and revoked are terminal: a
 * corrected document is a NEW upload, so the history of what was presented stays intact. Mirrored by
 * `core.staff_document_guard()` in the database.
 */
export const STAFF_DOCUMENT_TRANSITIONS: TransitionTable<StaffDocumentStatusType> =
  {
    [StaffDocumentStatus.PENDING]: [
      StaffDocumentStatus.VERIFIED,
      StaffDocumentStatus.REJECTED,
      StaffDocumentStatus.REVOKED,
    ],
    [StaffDocumentStatus.VERIFIED]: [StaffDocumentStatus.REVOKED],
    [StaffDocumentStatus.REJECTED]: [],
    [StaffDocumentStatus.REVOKED]: [],
  };
