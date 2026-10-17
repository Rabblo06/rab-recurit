/**
 * Turns a recorded User-Agent into a short "Browser on OS" label and a device kind for the icon. Descriptive only — a User-Agent
 * identifies software, never a physical device, so it is never used to group, merge or revoke sessions.
 *
 * Order matters: Edge/Opera/Samsung Internet all contain "Chrome", Chrome contains "Safari"; Android contains "Linux" and iPadOS
 * Safari may claim "Mac OS X" while still saying "iPad"/"Mobile".
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

export type DeviceKind = 'desktop' | 'mobile' | 'tablet';

export interface DeviceLabel {
  label: string;
  kind: DeviceKind;
}

export function describeDevice(userAgent: string | null): DeviceLabel {
  if (!userAgent) return { label: 'Unknown device', kind: 'desktop' };
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const kind: DeviceKind = /iPad|Tablet/.test(userAgent) ? 'tablet' : /Mobi|iPhone|iPod|Android/.test(userAgent) ? 'mobile' : 'desktop';
  const label = browser && os ? `${browser} on ${os}` : browser ?? os ?? 'Unknown device';
  return { label, kind };
}
