/** See rab-workforce-architecture.md §12. */
export const motion = {
  duration: {
    state: 150,
    sheet: 220,
    page: 300,
    activeShiftPulse: 2000,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
  },
} as const;
