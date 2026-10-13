import { layoutHalftoneParticles } from './buildWelcomeHalftoneParticles';
import { WELCOME_HALFTONE_PARTICLES } from './welcomeHalftoneParticles';

describe('layoutHalftoneParticles', () => {
  it('produces one runtime particle per source particle', () => {
    const particles = layoutHalftoneParticles(800, 600);
    expect(particles).toHaveLength(WELCOME_HALFTONE_PARTICLES.length);
  });

  it('centers the assembled ring on the canvas regardless of aspect ratio', () => {
    const wide = layoutHalftoneParticles(1600, 400);
    const avgX = wide.reduce((sum, p) => sum + p.targetX, 0) / wide.length;
    const avgY = wide.reduce((sum, p) => sum + p.targetY, 0) / wide.length;
    // The source geometry isn't perfectly symmetric, but the average of ~680 scattered dashes
    // should land close to the canvas center either way — a gross centering bug (e.g. using only
    // one dimension, or an off-by-one on the normalization) would show up as a large offset.
    expect(Math.abs(avgX - 800)).toBeLessThan(80);
    expect(Math.abs(avgY - 200)).toBeLessThan(80);
  });

  it('is deterministic across repeated calls at the same size — same stable per-particle randomness', () => {
    const a = layoutHalftoneParticles(1000, 700);
    const b = layoutHalftoneParticles(1000, 700);
    expect(a).toEqual(b);
  });

  it('rescales target positions proportionally on resize without reshuffling per-particle randomness', () => {
    const small = layoutHalftoneParticles(400, 300);
    const large = layoutHalftoneParticles(800, 600);
    // Same canvas aspect ratio doubled — targets should scale by exactly 2x from the shared center.
    for (let i = 0; i < small.length; i += 97) {
      const s = small[i]!;
      const l = large[i]!;
      expect(l.targetX - 400).toBeCloseTo((s.targetX - 200) * 2, 5);
      expect(l.targetY - 300).toBeCloseTo((s.targetY - 150) * 2, 5);
      // Stable randomness must be IDENTICAL across sizes — only target geometry rescales.
      expect(l.scatterAngle).toBe(s.scatterAngle);
      expect(l.entranceDelayFraction).toBe(s.entranceDelayFraction);
      expect(l.idlePhaseSeed).toBe(s.idlePhaseSeed);
    }
  });

  it('every particle has a positive length and thickness, and a shape/size within a sane bound of the canvas', () => {
    const particles = layoutHalftoneParticles(1000, 1000);
    for (const p of particles) {
      expect(p.len).toBeGreaterThan(0);
      expect(p.thickness).toBeGreaterThan(0);
      expect(p.len).toBeLessThan(1000);
      expect(p.scatterRadiusFraction).toBeGreaterThan(0);
      expect(p.entranceDelayFraction).toBeGreaterThanOrEqual(0);
      expect(p.entranceDelayFraction).toBeLessThanOrEqual(1);
    }
  });
});
