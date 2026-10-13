import { WELCOME_HALFTONE_PARTICLES } from './welcomeHalftoneParticles';

/** `vbH / vbW` of the source `welcome-halftone.svg` (239.098 / 297.037) — applied to the y axis
 * only so the ring keeps its true proportions under a single uniform scale, regardless of the
 * viewport's own (usually different) aspect ratio. */
const SOURCE_ASPECT_H_OVER_W = 239.098 / 297.037;

/** How much of the viewport's shorter side the assembled ring spans — > 1 means it bleeds off the
 * edges a little, matching the "very large ring covering much of the viewport" brief rather than
 * a ring that reads as a small centered icon. */
const RING_COVERAGE = 1.3;

export interface HalftoneParticleRuntime {
  /** Assembled (resting) position and size in canvas pixels — recomputed on every resize. */
  targetX: number;
  targetY: number;
  len: number;
  thickness: number;
  /** Stable per-particle randomness, generated once per canvas mount and never re-rolled on
   * resize (resize only rescales `target*`, keeping a particle's relative scatter direction and
   * timing identical) — a reshuffled entrance on every window resize would read as broken, not
   * organic. */
  scatterAngle: number;
  scatterRadiusFraction: number;
  entranceDelayFraction: number;
  idlePhaseSeed: number;
  idleAmplitudeFraction: number;
  exitDelayFraction: number;
}

/**
 * One mulberry32-style PRNG, seeded, so a given particle index always gets the same "random"
 * entrance delay/scatter angle/idle phase across resizes within the same mount (`layoutParticles`
 * is called again on every resize, and must reproduce identical per-particle randomness, or the
 * assembly would visibly reshuffle). Not cryptographic — just needs to be stable and cheap.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the per-particle runtime list for a given canvas size. Pure — no DOM, no timers, so it's
 * trivially testable and safe to call on every ResizeObserver tick.
 */
export function layoutHalftoneParticles(canvasWidth: number, canvasHeight: number): HalftoneParticleRuntime[] {
  const scale = Math.min(canvasWidth, canvasHeight) * RING_COVERAGE;
  const cx0 = canvasWidth / 2;
  const cy0 = canvasHeight / 2;

  return WELCOME_HALFTONE_PARTICLES.map(([ncx, ncy, nlen, nw], i) => {
    const rand = mulberry32(i * 2654435761 + 1);
    return {
      targetX: cx0 + (ncx - 0.5) * scale,
      targetY: cy0 + (ncy - 0.5) * scale * SOURCE_ASPECT_H_OVER_W,
      len: nlen * scale,
      // True SVG stroke width at this scale — no minimum floor, so the finest halftone dots stay
      // as fine as they are in welcome-halftone.svg instead of being inflated.
      thickness: nw * scale,
      scatterAngle: rand() * Math.PI * 2,
      scatterRadiusFraction: 0.18 + rand() * 0.42,
      entranceDelayFraction: rand(),
      idlePhaseSeed: rand() * Math.PI * 2,
      idleAmplitudeFraction: 0.35 + rand() * 0.65,
      exitDelayFraction: rand(),
    };
  });
}
