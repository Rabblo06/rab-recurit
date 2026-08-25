export const Theme = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
} as const;

export type ThemeType = (typeof Theme)[keyof typeof Theme];

export const NavPreference = {
  SIDE_PANEL: 'side_panel',
  FULL_PAGE: 'full_page',
} as const;

export type NavPreferenceType = (typeof NavPreference)[keyof typeof NavPreference];

export const DateFormat = {
  DD_MM_YYYY: 'DD/MM/YYYY',
  MM_DD_YYYY: 'MM/DD/YYYY',
  YYYY_MM_DD: 'YYYY-MM-DD',
} as const;

export type DateFormatType = (typeof DateFormat)[keyof typeof DateFormat];

export const TimeFormat = {
  H12: '12h',
  H24: '24h',
} as const;

export type TimeFormatType = (typeof TimeFormat)[keyof typeof TimeFormat];

export const FirstDayOfWeek = {
  MONDAY: 'monday',
  SUNDAY: 'sunday',
} as const;

export type FirstDayOfWeekType = (typeof FirstDayOfWeek)[keyof typeof FirstDayOfWeek];
