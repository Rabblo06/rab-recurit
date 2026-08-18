import { colors } from './colors';
import { radius, space } from './space';

function flatten(prefix: string, obj: Record<string, unknown>, out: Record<string, string>): void {
  for (const [key, value] of Object.entries(obj)) {
    const name = key === 'DEFAULT' ? prefix : `${prefix}-${key}`;
    if (typeof value === 'object' && value !== null) {
      flatten(name, value as Record<string, unknown>, out);
    } else {
      out[name] = String(value);
    }
  }
}

/**
 * Emits `--rab-*` CSS custom properties for `rab-front` to consume via
 * Tailwind's `theme()` / arbitrary-value syntax, so web and mobile read
 * from the same source values.
 */
export function toCssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  flatten('color', colors, out);
  const spaceVars = Object.fromEntries(
    Object.entries(space).map(([key, value]) => [`space-${key}`, `${value}px`]),
  );
  const radiusVars = Object.fromEntries(
    Object.entries(radius).map(([key, value]) => [
      `radius-${key}`,
      value === radius.full ? '9999px' : `${value}px`,
    ]),
  );
  const named: Record<string, string> = {};
  for (const [key, value] of Object.entries(out)) named[`--rab-${key}`] = value;
  for (const [key, value] of Object.entries(spaceVars)) named[`--rab-${key}`] = value;
  for (const [key, value] of Object.entries(radiusVars)) named[`--rab-${key}`] = value;
  return named;
}
