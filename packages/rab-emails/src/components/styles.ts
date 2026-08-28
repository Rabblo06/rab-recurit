/**
 * Shared email design tokens — mirrors the palette already hardcoded across
 * the three original templates (`#12735A` accent, `#F2F3F1` background,
 * `#111312`/`#6B7270`/`#9AA09E` text tiers) so every email in this package
 * looks like one system instead of each template picking its own colors.
 * Email clients need a real web-safe fallback, not just Inter — matches the
 * `Inter, system-ui, sans-serif` stack already used everywhere else.
 */
export const emailTheme = {
  font: {
    family: 'Inter, system-ui, sans-serif',
    weight: { regular: 400, bold: 600 },
    size: { sm: '13px', md: '14px', lg: '17px', xl: '24px' },
    lineHeight: '22px',
    colors: {
      primary: '#111312',
      secondary: '#6B7270',
      tertiary: '#9AA09E',
      inverted: '#FFFFFF',
    },
  },
  border: {
    radius: { sm: '8px', md: '16px' },
    color: '#E3E6E3',
  },
  background: {
    page: '#F2F3F1',
    card: '#FFFFFF',
    highlight: '#E9EBE8',
  },
  accent: {
    default: '#12735A',
    strong: '#0C5643',
  },
  danger: '#B42318',
} as const;
