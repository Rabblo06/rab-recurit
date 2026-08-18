import { OfferStatus, OfferStatusType } from '../types';
import { TransitionTable } from './assert-transition';

export const OFFER_TRANSITIONS: TransitionTable<OfferStatusType> = {
  [OfferStatus.PENDING]: [
    OfferStatus.STAFF_ACCEPTED,
    OfferStatus.DECLINED,
    OfferStatus.EXPIRED,
    OfferStatus.WITHDRAWN,
  ],
  // Staff acceptance only reserves the offer for manager review — the
  // manager must separately confirm or reject it. Staff can never reach
  // MANAGER_CONFIRMED directly; that edge does not exist on this row.
  [OfferStatus.STAFF_ACCEPTED]: [OfferStatus.MANAGER_CONFIRMED, OfferStatus.MANAGER_REJECTED],
  [OfferStatus.MANAGER_CONFIRMED]: [],
  [OfferStatus.MANAGER_REJECTED]: [],
  [OfferStatus.DECLINED]: [],
  [OfferStatus.EXPIRED]: [],
  [OfferStatus.WITHDRAWN]: [],
};
