import { VenueStatus, VenueStatusType } from '../types';
import { TransitionTable } from './assert-transition';

/**
 * `Venue.status` — mutated only by `VenueService.archive` / `VenueService.restore` (wave 5 added the restore edge).
 * The archive columns (`archived_at`/`archived_by`, ARCHIVE_TRANSITIONS) move in the same UPDATE; venues archived
 * before those columns existed carry `status = 'archived'` with `archived_at IS NULL` and are restorable too.
 */
export const VENUE_TRANSITIONS: TransitionTable<VenueStatusType> = {
  [VenueStatus.ACTIVE]: [VenueStatus.ARCHIVED],
  [VenueStatus.ARCHIVED]: [VenueStatus.ACTIVE],
};
