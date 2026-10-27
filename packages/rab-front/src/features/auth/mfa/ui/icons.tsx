/**
 * The account-security design's own stroke icons (docs/design/crewflow-account-security.html `paths`), drawn the same
 * way: 24×24 viewBox, 1.65 stroke, round caps. Decorative only (`aria-hidden`); every control carries its own label.
 */
const PATHS = {
  shield:
    'M12 3L20 6V12C20 17 16 20 12 22C8 20 4 17 4 12V6L12 3Z M8 12L11 15L16 10',
  lock: 'M6 10H18V21H6Z M8 10V7A4 4 0 0 1 16 7V10 M12 14V17',
  close: 'M6 6L18 18 M18 6L6 18',
  check: 'M5 12L10 17L20 7',
  info: 'M12 8H12.01 M12 11V16 M22 12A10 10 0 1 1 2 12A10 10 0 1 1 22 12',
  phone: 'M7 2H17V22H7Z M10 18H14',
  copy: 'M8 8H21V21H8Z M16 8V3H3V16H8',
  download: 'M12 3V15 M7 10L12 15L17 10 M4 17V21H20V17',
  eye: 'M2 12C6 4 18 4 22 12C18 20 6 20 2 12Z M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12',
  eyeOff:
    'M2 12C6 4 18 4 22 12C18 20 6 20 2 12Z M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12 M4 4L20 20',
  key: 'M14 10A5 5 0 1 0 4 10A5 5 0 1 0 14 10 M14 10H22 M19 10V14',
  desktop: 'M3 4H21V17H3Z M8 21H16 M12 17V21',
  refresh: 'M20 6V11H15 M4 18V13H9 M20 11A8 8 0 0 0 6 6 M4 13A8 8 0 0 0 18 18',
} as const;

export type AcsIconName = keyof typeof PATHS;

export function AcsIcon({
  name,
  className = '',
}: {
  name: AcsIconName;
  className?: string;
}) {
  return (
    <svg
      className={`acs-icon ${className}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
