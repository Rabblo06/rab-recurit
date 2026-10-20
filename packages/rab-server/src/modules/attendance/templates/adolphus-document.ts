import { escapeHtml } from '../../../engine/utils/escape-html';
import { ADOLPHUS_LOGO_DATA_URI } from './adolphus-logo';

/**
 * Shared Adolphus Group document styling for the pre-shift attendance sheet and the final timesheet (owner reference
 * designs 2026-10-17): logo header, thin orange rule, dark table heading, alternating light rows, A4 landscape.
 * Plain template-literal HTML rendered by the existing Playwright pipeline (`render-pdf.util.ts`); every user-supplied
 * value goes through `escapeHtml`. Optional fields are omitted when absent — never printed as a literal placeholder.
 */
export interface DocumentShiftInfo {
  venueName: string;
  venueAddress?: string | null;
  roleName: string;
  department?: string | null;
  startsAt: string;
  endsAt: string;
  contactName?: string | null;
  contactPhone?: string | null;
  shiftReference: string;
  workspaceName?: string | null;
  notes?: string | null;
  /** IANA zone the times are printed in (organisation timezone, default Europe/London). */
  timezone: string;
  generatedAt: string;
}

export const ORANGE = '#E8711C';

export function fmtDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export function fmtTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function fmtDateTime(iso: string, tz: string): string {
  return `${fmtDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

/** "Department / role", "Date · Scheduled", "Contact", "Shift reference" — optional lines only when the data exists. */
export function shiftDetailsHtml(s: DocumentShiftInfo): string {
  const role = s.department ? `Department / role: ${escapeHtml(s.department)} · ${escapeHtml(s.roleName)}` : `Role: ${escapeHtml(s.roleName)}`;
  const contact = [s.contactName, s.contactPhone].filter((v): v is string => !!v && v.trim().length > 0).map(escapeHtml).join(' · ');
  return `
    <h1 class="venue">${escapeHtml(s.venueName)}</h1>
    <div class="details">
      ${s.venueAddress ? `<div>${escapeHtml(s.venueAddress)}</div>` : ''}
      <div>${role}</div>
      <div>Date: ${escapeHtml(fmtDate(s.startsAt, s.timezone))} &nbsp;&nbsp; Scheduled: ${escapeHtml(fmtTime(s.startsAt, s.timezone))}–${escapeHtml(fmtTime(s.endsAt, s.timezone))}</div>
      ${contact ? `<div>Contact: ${contact}</div>` : ''}
      <div>Shift reference: ${escapeHtml(s.shiftReference)}</div>
    </div>`;
}

export function documentHeaderHtml(title: string): string {
  return `
  <header class="doc-header">
    <img class="logo" src="${ADOLPHUS_LOGO_DATA_URI}" alt="Adolphus Group — recruitment consultants">
    <div class="doc-title">${escapeHtml(title)}</div>
  </header>
  <div class="rule"></div>`;
}

export function staffCellHtml(name: string, sub: string): string {
  return `<div class="staff"><span class="avatar">${escapeHtml(initials(name))}</span><span><b>${escapeHtml(name)}</b><br><small>${escapeHtml(sub)}</small></span></div>`;
}

/**
 * Playwright per-page footer (`page.pdf({ displayHeaderFooter, footerTemplate })`): workspace / reference on the left,
 * generated time and page x of y on the right. Footer templates do not inherit page CSS, so styles are inline.
 */
export function documentFooterTemplate(s: DocumentShiftInfo): string {
  const left = [s.workspaceName, s.shiftReference].filter(Boolean).map((v) => escapeHtml(v!)).join(' · ');
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 7.5px; color: #8A8F8C; width: 100%; padding: 0 12mm; display: flex; justify-content: space-between;">
    <span>${left}</span>
    <span>Generated ${escapeHtml(fmtDateTime(s.generatedAt, s.timezone))} · Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}

export const DOCUMENT_CSS = `
  @page { size: A4 landscape; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1F2321; margin: 0; font-size: 11px; }
  .doc-header { display: flex; align-items: flex-end; justify-content: space-between; }
  .logo { height: 52px; }
  .doc-title { font-size: 15px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding-bottom: 6px; }
  .rule { height: 2px; background: ${ORANGE}; margin: 10px 0 18px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  h1.venue { font-size: 22px; margin: 0 0 8px; font-weight: 700; }
  .details { color: #6B7270; line-height: 1.7; font-size: 11.5px; }
  .summary { color: #6B7270; margin: 16px 0 8px; font-size: 10.5px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { background: #2A2B29; color: #fff; text-align: left; font-size: 10.5px; font-weight: 600; padding: 9px 10px; }
  td { padding: 8px 10px; font-size: 10.5px; vertical-align: middle; border-bottom: 1px solid #ECEDEB; }
  tbody tr:nth-child(even) td { background: #F4F5F3; }
  .muted { color: #8A8F8C; }
  .staff { display: flex; align-items: center; gap: 9px; }
  .staff small { color: #8A8F8C; font-size: 9px; }
  .avatar { width: 26px; height: 26px; border-radius: 50%; background: #E6E7E5; color: #4A4F4C; font-size: 9px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .note-line { color: #8A8F8C; font-size: 9.5px; margin-top: 8px; }
  .bottom { display: flex; gap: 40px; margin-top: 22px; page-break-inside: avoid; }
  .bottom > div { flex: 1; }
  .bottom h3 { font-size: 10.5px; margin: 0 0 8px; letter-spacing: .3px; }
  .bottom p { margin: 0 0 6px; }
  .flag { color: #B45309; font-weight: 600; }
`;
