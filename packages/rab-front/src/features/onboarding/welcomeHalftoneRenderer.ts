import type { HalftoneParticleRuntime } from './buildWelcomeHalftoneParticles';

export const ENTRANCE_DURATION_MS = 900;
/** Entrance delays are spread across this additional window on top of each particle's own
 * duration, so the assembly reads as a wave rather than every dash arriving in lockstep. */
export const ENTRANCE_STAGGER_WINDOW_MS = 650;
export const EXIT_DURATION_MS = 700;
export const EXIT_STAGGER_WINDOW_MS = 350;
const IDLE_PERIOD_MS = 3400;
const IDLE_AMPLITUDE_PX = 2.2;

function easeOutCubic(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return 1 - (1 - c) ** 3;
}

function easeInCubic(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c ** 3;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface RenderFrameParams {
  ctx: CanvasRenderingContext2D;
  particles: readonly HalftoneParticleRuntime[];
  /** ms since this canvas mounted (entrance reference clock). */
  elapsedMs: number;
  /** ms since `exiting` first became true, or `null` while not exiting. */
  exitElapsedMs: number | null;
  reduceMotion: boolean;
  color: string;
  canvasWidth: number;
  canvasHeight: number;
}

/** Diagonal of the canvas — the natural unit for a scatter radius that should feel proportional to
 * the viewport regardless of aspect ratio. */
function diagonal(w: number, h: number): number {
  return Math.sqrt(w * w + h * h);
}

/**
 * Draws one frame and returns whether the exit animation has fully finished (so the caller can
 * fire its "unmount me now" callback exactly once, from the same clock driving the draw — never a
 * separate, potentially-drifting `setTimeout`).
 *
 * `exitComplete` is only meaningful for the animated (non-reduced-motion) path, where it tracks
 * every particle's own exit-dispersal progress. Under `reduceMotion` this function stops drawing
 * particles immediately once `exitElapsedMs` is set (no scatter/burst movement, per the
 * reduced-motion requirement) and `exitComplete` reads `true` on that very first frame — the
 * VISUAL fade in that case is a plain CSS opacity transition on the canvas's container element,
 * owned by the component, not by this per-frame flag; the component does not use this return
 * value to time that case's unmount.
 */
export function renderHalftoneFrame(params: RenderFrameParams): { exitComplete: boolean } {
  const { ctx, particles, elapsedMs, exitElapsedMs, reduceMotion, color, canvasWidth, canvasHeight } = params;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';

  const diag = diagonal(canvasWidth, canvasHeight);
  let allExited = exitElapsedMs !== null;

  for (const p of particles) {
    let x = p.targetX;
    let y = p.targetY;
    let opacity = 1;
    let thicknessScale = 1;

    if (reduceMotion) {
      // Static final frame only — no scatter entrance, no idle drift, no exit dispersal. A plain
      // fade (driven by the canvas's own container opacity in the component, not here) is used
      // for the reduced-motion exit instead of animating position.
      if (exitElapsedMs !== null) opacity = 0; // the component's CSS fade handles visibility; this just stops drawing once exit starts
    } else {
      const entranceProgress = easeOutCubic(
        (elapsedMs - p.entranceDelayFraction * ENTRANCE_STAGGER_WINDOW_MS) / ENTRANCE_DURATION_MS,
      );
      const scatterX = p.targetX + Math.cos(p.scatterAngle) * p.scatterRadiusFraction * diag;
      const scatterY = p.targetY + Math.sin(p.scatterAngle) * p.scatterRadiusFraction * diag;

      x = lerp(scatterX, p.targetX, entranceProgress);
      y = lerp(scatterY, p.targetY, entranceProgress);
      opacity = entranceProgress;
      thicknessScale = lerp(0.3, 1, entranceProgress);

      if (entranceProgress >= 1 && exitElapsedMs === null) {
        // Idle drift only once fully assembled — subtle, independent per-particle phase so the
        // ring breathes rather than bobbing as one rigid unit.
        const idle = Math.sin(elapsedMs / IDLE_PERIOD_MS + p.idlePhaseSeed) * IDLE_AMPLITUDE_PX * p.idleAmplitudeFraction;
        y += idle;
      }

      if (exitElapsedMs !== null) {
        const exitProgress = easeInCubic(
          (exitElapsedMs - p.exitDelayFraction * EXIT_STAGGER_WINDOW_MS) / EXIT_DURATION_MS,
        );
        const exitX = p.targetX + Math.cos(p.scatterAngle) * (p.scatterRadiusFraction + 0.5) * diag;
        const exitY = p.targetY + Math.sin(p.scatterAngle) * (p.scatterRadiusFraction + 0.5) * diag;
        x = lerp(p.targetX, exitX, exitProgress);
        y = lerp(p.targetY, exitY, exitProgress);
        opacity = lerp(1, 0, exitProgress);
        if (exitProgress < 1) allExited = false;
      }
    }

    if (opacity <= 0.002) continue;
    ctx.globalAlpha = opacity;
    // Tiny floor only because canvas ignores a lineWidth of 0 (it would keep the previous dash's
    // width); otherwise every dot is drawn at its true welcome-halftone.svg size.
    ctx.lineWidth = Math.max(p.thickness * thicknessScale, 0.01);
    ctx.beginPath();
    ctx.moveTo(x - p.len / 2, y);
    ctx.lineTo(x + p.len / 2, y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  return { exitComplete: exitElapsedMs !== null && (reduceMotion || allExited) };
}
