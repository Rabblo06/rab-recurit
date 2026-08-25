import { VenueStatus, VenueStatusType } from '../types';
import { TransitionTable } from './assert-transition';

/** `Venue.status` — only mutator today is `VenueService.archive`, one-directional. No unarchive endpoint exists. */
export const VENUE_TRANSITIONS: TransitionTable<VenueStatusType> = {
  [VenueStatus.ACTIVE]: [VenueStatus.ARCHIVED],
  [VenueStatus.ARCHIVED]: [],
};
