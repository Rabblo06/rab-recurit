/** 4px scale. See rab-workforce-architecture.md §12. */
export const space = {
  0: 0,
  1: 2,
  2: 4,
  3: 8,
  4: 12,
  5: 16,
  6: 20,
  7: 24,
  8: 32,
  9: 48,
  10: 64,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

export const elevation = {
  card: '0 1px 2px rgba(17, 19, 18, 0.06)',
  modal: '0 8px 24px rgba(17, 19, 18, 0.10)',
} as const;
