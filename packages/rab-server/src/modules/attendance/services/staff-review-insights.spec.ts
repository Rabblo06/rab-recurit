import { aggregateStaffReviews, reviewerOptions, StaffReviewRow } from './staff-review-insights';

let n = 0;
const row = (reviewer: string, r: [number, number, number, number, number], startsAt = '2026-10-17T18:00:00Z'): StaffReviewRow => ({
  id: `r${++n}`, shiftId: `s${n}`, reviewerUserId: reviewer, reviewerName: reviewer === 'sarah' ? 'Sarah Mitchell' : 'James Wilson',
  venueName: reviewer === 'sarah' ? 'The Savoy' : "Claridge's", roleName: 'Waiter', startsAt: new Date(startsAt),
  endsAt: new Date(startsAt), grooming: r[0], attitude: r[1], skills: r[2], attendance: r[3], timeKeeping: r[4],
  feedback: null, createdAt: new Date(startsAt), updatedAt: new Date(startsAt),
});

describe('Staff review aggregation', () => {
  it('no reviews: nothing is invented', () => {
    const a = aggregateStaffReviews([], null);
    expect(a).toMatchObject({ total: 0, reviewerCount: 0, average: null, history: [] });
    expect(Object.values(a.categories).every((v) => v === null)).toBe(true);
    expect(a.distribution.map((d) => d.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('averages review scores, rounds each review to the nearest star for the distribution, and averages categories', () => {
    const rows = [row('sarah', [5, 5, 4, 5, 4]), row('sarah', [4, 4, 4, 5, 5]), row('james', [3, 3, 3, 3, 3])];
    const a = aggregateStaffReviews(rows, null);
    // Scores 4.6, 4.4, 3.0 → average 4.0; stars 5, 4, 3.
    expect(a.average).toBe(4);
    expect(a.total).toBe(3);
    expect(a.reviewerCount).toBe(2);
    expect(a.distribution).toEqual([
      { stars: 5, count: 1, percent: 33 }, { stars: 4, count: 1, percent: 33 }, { stars: 3, count: 1, percent: 33 },
      { stars: 2, count: 0, percent: 0 }, { stars: 1, count: 0, percent: 0 },
    ]);
    expect(a.categories).toEqual({ grooming: 4, attitude: 4, skills: 3.7, attendance: 4.3, timeKeeping: 4 });
    expect(a.history.map((h) => h.score)).toEqual([4.6, 4.4, 3]);
  });

  it('4.5 rounds up to five stars', () => {
    const a = aggregateStaffReviews([row('sarah', [5, 5, 4, 4, 4.5 as number])], null);
    expect(a.distribution.find((d) => d.stars === 5)?.count).toBe(1);
  });

  it('the reviewer filter changes the real figures, not only labels', () => {
    const rows = [row('sarah', [5, 5, 5, 5, 5]), row('james', [2, 2, 2, 2, 2])];
    expect(aggregateStaffReviews(rows, 'sarah')).toMatchObject({ total: 1, average: 5, reviewerCount: 1 });
    expect(aggregateStaffReviews(rows, 'james')).toMatchObject({ total: 1, average: 2 });
    expect(aggregateStaffReviews(rows, 'nobody')).toMatchObject({ total: 0, average: null });
  });

  it('reviewer options include every reviewer and Venue Managers with no reviews, busiest first', () => {
    const rows = [row('sarah', [5, 5, 5, 5, 5]), row('sarah', [4, 4, 4, 4, 4]), row('james', [4, 4, 4, 4, 4])];
    const options = reviewerOptions(rows, [
      { userId: 'sarah', name: 'Sarah Mitchell', venues: ['The Savoy'] },
      { userId: 'alex', name: 'Alex Morgan', venues: ['The Dorchester'] },
    ]);
    expect(options.map((o) => [o.name, o.reviews])).toEqual([['Sarah Mitchell', 2], ['James Wilson', 1], ['Alex Morgan', 0]]);
    expect(options.find((o) => o.userId === 'james')?.venues).toEqual(["Claridge's"]);
  });
});
