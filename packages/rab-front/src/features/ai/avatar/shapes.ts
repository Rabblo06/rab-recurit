import type { AiAssistantShape } from '@rab/shared';

/**
 * Crewflow assistant silhouettes — ORIGINAL geometry generated from parameters in a 64×64 box (TWENTY_UI_INVENTORY §3).
 * No traced artwork, no image files: every shape is computed here as one SVG path. Proportions are Crewflow's own and
 * open to owner review. The centre (32, 32) is inside every shape (the face sits there).
 */

const C = 32;
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** A closed path through polar samples r(θ) around the centre. */
function polar(r: (theta: number) => number, samples = 144): string {
  const pts: string[] = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i / samples) * Math.PI * 2 - Math.PI / 2;
    const rr = r(t);
    pts.push(`${fmt(C + rr * Math.cos(t))} ${fmt(C + rr * Math.sin(t))}`);
  }
  return `M${pts.join(' L')} Z`;
}

/** Distance from the centre to the far edge of a circle along direction θ (−∞ when the ray misses it). */
function rayToCircle(theta: number, cx: number, cy: number, radius: number): number {
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const dx = cx - C;
  const dy = cy - C;
  const b = ux * dx + uy * dy;
  const disc = b * b - (dx * dx + dy * dy) + radius * radius;
  return disc < 0 ? -Infinity : b + Math.sqrt(disc);
}

/** The outline of a union of circles (star-shaped from the centre). */
function circleUnion(circles: ReadonlyArray<readonly [number, number, number]>): string {
  return polar((t) => Math.max(...circles.map(([x, y, r]) => rayToCircle(t, x, y, r))), 216);
}

/** A polygon with rounded corners (each corner replaced by a quadratic curve through the vertex). */
function roundedPolygon(points: ReadonlyArray<readonly [number, number]>, radius: number): string {
  const n = points.length;
  const seg: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const [px, py] = points[(i - 1 + n) % n]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[(i + 1) % n]!;
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const a = Math.min(radius, inLen / 2) / inLen;
    const b = Math.min(radius, outLen / 2) / outLen;
    const start = [x + (px - x) * a, y + (py - y) * a];
    const end = [x + (nx - x) * b, y + (ny - y) * b];
    seg.push(`${i === 0 ? 'M' : 'L'}${fmt(start[0]!)} ${fmt(start[1]!)} Q${fmt(x)} ${fmt(y)} ${fmt(end[0]!)} ${fmt(end[1]!)}`);
  }
  return `${seg.join(' ')} Z`;
}

function regular(sides: number, radius: number, rotation: number): Array<[number, number]> {
  return Array.from({ length: sides }, (_, i) => {
    const t = rotation + (i / sides) * Math.PI * 2;
    return [C + radius * Math.cos(t), C + radius * Math.sin(t)] as [number, number];
  });
}

const GENERATORS: Record<AiAssistantShape, () => string> = {
  circle: () => polar(() => 28),
  // Superellipse |x|^4 + |y|^4 = a^4.
  squircle: () =>
    polar((t) => {
      const c = Math.abs(Math.cos(t));
      const s = Math.abs(Math.sin(t));
      return 28 / Math.pow(Math.pow(c, 4) + Math.pow(s, 4), 1 / 4);
    }),
  // r = R + a·cos(nθ): 9 shallow lobes.
  scallop: () => polar((t) => 26.5 + 2.6 * Math.cos(9 * t)),
  // A soft cloud: the outline of four overlapping circles.
  cloud: () => circleUnion([[21, 38, 13], [43, 38, 13], [30, 27, 15], [43, 28, 10]]),
  // Four leaves: four circles around the centre.
  clover: () => circleUnion([[32, 19.5, 13], [44.5, 32, 13], [32, 44.5, 13], [19.5, 32, 13]]),
  // Five rounded petals.
  flower: () => polar((t) => 19 + 10 * Math.pow(0.5 + 0.5 * Math.cos(5 * t), 1.6)),
  // A 12-point burst with rounded tips.
  burst: () => roundedPolygon(Array.from({ length: 24 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 24) * Math.PI * 2;
    const r = i % 2 === 0 ? 30 : 24.5;
    return [C + r * Math.cos(t), C + r * Math.sin(t)] as [number, number];
  }), 2.4),
  // A vertical stadium.
  pill: () => 'M12 25 A20 20 0 0 1 52 25 L52 39 A20 20 0 0 1 12 39 Z',
  // A rounded rhombus.
  gem: () => roundedPolygon([[32, 3], [61, 32], [32, 61], [3, 32]], 9),
  // A rounded hexagon (flat top).
  hexagon: () => roundedPolygon(regular(6, 30, 0), 7),
};

const cache = new Map<AiAssistantShape, string>();

/** The SVG path (`d`) of one silhouette in a 64×64 box. */
export function shapePath(shape: AiAssistantShape): string {
  let d = cache.get(shape);
  if (!d) {
    d = (GENERATORS[shape] ?? GENERATORS.circle)();
    cache.set(shape, d);
  }
  return d;
}

/** Human labels for the shape menu (Crewflow wording). */
export const AI_SHAPE_LABEL: Record<AiAssistantShape, string> = {
  circle: 'Circle',
  squircle: 'Rounded square',
  scallop: 'Scallop',
  cloud: 'Cloud',
  clover: 'Clover',
  flower: 'Flower',
  burst: 'Burst',
  pill: 'Pill',
  gem: 'Gem',
  hexagon: 'Hexagon',
};
