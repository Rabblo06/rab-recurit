/**
 * Pure aggregation behind the web Staff Reviews tab. Input rows are real `shift_staff_review` rows already scoped by the
 * service (tenant, owner, RLS) and by the date window; this only filters by reviewer and computes figures. Nothing is
 * invented: no reviews → null averages, zero counts, empty history.
 *
 * Score of one review = mean of its five 1-5 ratings. Overall average = mean of review scores. The distribution places
 * each review in its score rounded to the nearest star (4.5 → 5), which the UI states under the chart.
 */
export const REVIEW_CATEGORIES = ['grooming', 'attitude', 'skills', 'attendance', 'timeKeeping'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export interface StaffReviewRow {
  id: string;
  shiftId: string;
  reviewerUserId: string;
  reviewerName: string;
  venueName: string;
  roleName: string;
  startsAt: Date;
  endsAt: Date;
  grooming: number;
  attitude: number;
  skills: number;
  attendance: number;
  timeKeeping: number;
  feedback: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewerOption {
  userId: string;
  name: string;
  venues: string[];
  /** Reviews by this person for this staff member inside the date window (whatever reviewer is selected). */
  reviews: number;
}

export interface StaffReviewHistoryItem {
  id: string;
  shiftId: string;
  reviewerUserId: string;
  reviewerName: string;
  venueName: string;
  roleName: string;
  startsAt: string;
  endsAt: string;
  score: number;
  feedback: string | null;
  submittedAt: string;
  updatedAt: string;
}

export interface StaffReviewAggregate {
  total: number;
  reviewerCount: number;
  average: number | null;
  distribution: Array<{ stars: 1 | 2 | 3 | 4 | 5; count: number; percent: number }>;
  categories: Record<ReviewCategory, number | null>;
  history: StaffReviewHistoryItem[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
export const reviewScore = (r: Pick<StaffReviewRow, ReviewCategory>) =>
  (r.grooming + r.attitude + r.skills + r.attendance + r.timeKeeping) / 5;

export function aggregateStaffReviews(rows: StaffReviewRow[], reviewer: string | null): StaffReviewAggregate {
  const selected = reviewer ? rows.filter((r) => r.reviewerUserId === reviewer) : rows;
  const total = selected.length;
  const scores = selected.map(reviewScore);
  const distribution = ([5, 4, 3, 2, 1] as const).map((stars) => {
    const count = scores.filter((s) => Math.min(5, Math.max(1, Math.round(s))) === stars).length;
    return { stars, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });
  const categories = Object.fromEntries(
    REVIEW_CATEGORIES.map((c) => [c, total ? round1(selected.reduce((sum, r) => sum + r[c], 0) / total) : null]),
  ) as Record<ReviewCategory, number | null>;
  return {
    total,
    reviewerCount: new Set(selected.map((r) => r.reviewerUserId)).size,
    average: total ? round1(scores.reduce((a, b) => a + b, 0) / total) : null,
    distribution,
    categories,
    history: selected.map((r) => ({
      id: r.id,
      shiftId: r.shiftId,
      reviewerUserId: r.reviewerUserId,
      reviewerName: r.reviewerName,
      venueName: r.venueName,
      roleName: r.roleName,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      score: round1(reviewScore(r)),
      feedback: r.feedback,
      submittedAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

/** Reviewer dropdown: every reviewer with reviews in the window, plus the workspace's Venue Managers with none. */
export function reviewerOptions(
  rows: StaffReviewRow[],
  venueManagers: Array<{ userId: string; name: string; venues: string[] }>,
): ReviewerOption[] {
  const byUser = new Map<string, ReviewerOption>();
  for (const vm of venueManagers) byUser.set(vm.userId, { ...vm, reviews: 0 });
  for (const r of rows) {
    const current = byUser.get(r.reviewerUserId) ?? { userId: r.reviewerUserId, name: r.reviewerName, venues: [], reviews: 0 };
    current.reviews += 1;
    if (!current.venues.includes(r.venueName) && !venueManagers.some((v) => v.userId === r.reviewerUserId)) current.venues.push(r.venueName);
    byUser.set(r.reviewerUserId, current);
  }
  return [...byUser.values()].sort((a, b) => b.reviews - a.reviews || a.name.localeCompare(b.name));
}
