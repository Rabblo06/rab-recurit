/** See rab-workforce-architecture.md §12. */
export const fontFamily = {
  body: "'Inter', system-ui, sans-serif",
  display: "'Inter Display', 'Inter', system-ui, sans-serif",
};

export interface TypeScale {
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  letterSpacing?: string;
  tabularNums?: boolean;
}

export const typeScale = {
  screenTitle: { fontSize: 30, lineHeight: 36, fontWeight: 700, letterSpacing: '-0.02em' },
  pageTitle: { fontSize: 24, lineHeight: 30, fontWeight: 600, letterSpacing: '-0.015em' },
  section: { fontSize: 18, lineHeight: 24, fontWeight: 600 },
  bodyMobile: { fontSize: 15, lineHeight: 22, fontWeight: 400 },
  bodyWeb: { fontSize: 14, lineHeight: 20, fontWeight: 400 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: 400 },
  metricMobile: { fontSize: 28, lineHeight: 34, fontWeight: 700, tabularNums: true },
  metricWeb: { fontSize: 24, lineHeight: 30, fontWeight: 700, tabularNums: true },
  timer: { fontSize: 30, lineHeight: 36, fontWeight: 600, tabularNums: true },
} as const satisfies Record<string, TypeScale>;
