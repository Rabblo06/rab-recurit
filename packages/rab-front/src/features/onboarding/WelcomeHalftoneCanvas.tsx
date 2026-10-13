import { useEffect, useRef } from 'react';
import { layoutHalftoneParticles, type HalftoneParticleRuntime } from './buildWelcomeHalftoneParticles';
import { renderHalftoneFrame } from './welcomeHalftoneRenderer';

const MAX_DPR = 2;
/** Reduced motion means no animated transition, not a slower one — an instant cut is the correct,
 * expected behaviour for `prefers-reduced-motion` (matches this component's pre-redesign exit
 * timing, which also fired immediately once `leaving`). Also used as the (degenerate, 0ms) CSS
 * transition duration for the same case — kept as one named constant rather than two numbers that
 * could drift apart. Also the fallback used when no 2D context is available at all (robustness —
 * see `canAnimateRef`'s own doc comment). */
const REDUCED_MOTION_EXIT_MS = 0;

interface WelcomeHalftoneCanvasProps {
  /** True once the caller wants this to animate out. Never reset back to false. */
  exiting: boolean;
  reduceMotion: boolean;
  /** Fired exactly once, when the exit animation (or, under reduced motion, the fade) has
   * genuinely finished on screen — the caller unmounts/navigates here, never on a guess. */
  onExitComplete?: () => void;
}

/**
 * Canvas-driven halftone ring, assembled from `welcome-halftone.svg`'s own dash geometry (see
 * `buildWelcomeHalftoneParticles.ts`'s doc comment) — an original Crewflow renderer, not Twenty's
 * AGPL implementation. Owns its own `requestAnimationFrame` loop entirely outside React state:
 * every per-frame value is computed analytically from elapsed time in `welcomeHalftoneRenderer.ts`
 * (never stepped/integrated), so there is nothing here that would cause an extra React re-render
 * per frame — the component itself re-renders only when `exiting`/`reduceMotion` change.
 */
export default function WelcomeHalftoneCanvas({ exiting, reduceMotion, onExitComplete }: WelcomeHalftoneCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<HalftoneParticleRuntime[]>([]);
  const sizeRef = useRef({ width: 0, height: 0 });
  const mountTimeRef = useRef<number | null>(null);
  const exitStartRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const colorRef = useRef('#b5502e');
  // False whenever a real 2D context couldn't be obtained at all (jsdom in tests, or any real
  // environment without canvas support) — the fallback timeout effect below then drives
  // `onExitComplete` the same bounded way reduced motion does, so a missing/broken canvas can
  // never hang onboarding forever waiting for a frame loop that will never run.
  const canAnimateRef = useRef(true);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  function drawStatic(ctx: CanvasRenderingContext2D) {
    renderHalftoneFrame({
      ctx,
      particles: particlesRef.current,
      elapsedMs: Number.POSITIVE_INFINITY,
      exitElapsedMs: exitingRef.current ? 0 : null,
      reduceMotion: true,
      color: colorRef.current,
      canvasWidth: sizeRef.current.width,
      canvasHeight: sizeRef.current.height,
    });
  }

  // Resize handling — rebuilds particle TARGET positions only; each particle's own stable
  // randomness (scatter angle/delay/idle phase) is re-derived deterministically from its index
  // (see `layoutHalftoneParticles`'s own doc comment), so a resize mid-animation reflows smoothly
  // instead of reshuffling the assembly.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    function resize() {
      if (!container || !canvas) return;
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width: rect.width, height: rect.height };
      particlesRef.current = layoutHalftoneParticles(rect.width, rect.height);
      // Resizing the canvas clears it. The animated path redraws on its next frame, but the
      // reduced-motion path draws only once, so it must redraw its static frame here.
      if (ctx && reduceMotionRef.current) drawStatic(ctx);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // The rAF loop itself — one effect, started once, torn down on unmount. `exiting` is read via
  // `exitingRef` (refreshed each render) rather than restarting this effect, so starting the exit
  // never resets the entrance clock.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      canAnimateRef.current = false;
      return;
    }

    colorRef.current = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#b5502e';
    mountTimeRef.current = performance.now();

    if (reduceMotion) {
      // Static final frame, drawn once — no rAF loop needed at all while not exiting.
      const { width, height } = sizeRef.current;
      if (particlesRef.current.length === 0 && width > 0) particlesRef.current = layoutHalftoneParticles(width, height);
      drawStatic(ctx);
      return;
    }

    function frame(now: number) {
      if (!canvas || !ctx) return;
      const mountTime = mountTimeRef.current ?? now;
      if (exitingRef.current && exitStartRef.current === null) exitStartRef.current = now;

      const { exitComplete } = renderHalftoneFrame({
        ctx,
        particles: particlesRef.current,
        elapsedMs: now - mountTime,
        exitElapsedMs: exitStartRef.current === null ? null : now - exitStartRef.current,
        reduceMotion: false,
        color: colorRef.current,
        canvasWidth: sizeRef.current.width,
        canvasHeight: sizeRef.current.height,
      });

      if (exitComplete && !doneRef.current) {
        doneRef.current = true;
        onExitComplete?.();
        return; // stop scheduling further frames once fully dispersed
      }
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // Fallback exit timing — fires whenever the real rAF-driven exit above can't run at all: reduced
  // motion (by design, see this component's own doc comment) OR no usable 2D context (robustness:
  // a canvas that silently can't render, for any reason, must never hang onboarding forever
  // waiting for a frame loop that will never execute — see `canAnimateRef`'s own doc comment).
  useEffect(() => {
    if (!exiting || doneRef.current) return;
    if (!reduceMotion && canAnimateRef.current) return; // the real rAF path above owns this case
    const id = setTimeout(() => {
      doneRef.current = true;
      onExitComplete?.();
    }, REDUCED_MOTION_EXIT_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, exiting]);

  const fadeOut = exiting && (reduceMotion || !canAnimateRef.current);

  return (
    <div
      ref={containerRef}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        opacity: fadeOut ? 0 : 1,
        transition: `opacity ${REDUCED_MOTION_EXIT_MS}ms ease`,
        pointerEvents: 'none',
      }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
