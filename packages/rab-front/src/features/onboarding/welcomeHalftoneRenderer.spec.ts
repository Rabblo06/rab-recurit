import { renderHalftoneFrame, ENTRANCE_DURATION_MS, ENTRANCE_STAGGER_WINDOW_MS, EXIT_DURATION_MS, EXIT_STAGGER_WINDOW_MS } from './welcomeHalftoneRenderer';
import { layoutHalftoneParticles } from './buildWelcomeHalftoneParticles';

/** Minimal stand-in for CanvasRenderingContext2D — records calls instead of actually drawing
 * (jsdom has no real canvas backend; the point of this test is verifying the renderer's OWN
 * control flow, not pixel output). */
function mockCtx() {
  return {
    clearRect: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
    strokeStyle: '',
    lineCap: '',
    lineWidth: 0,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe('renderHalftoneFrame', () => {
  const particles = layoutHalftoneParticles(400, 300);

  it('draws nothing (opacity-skipped) before any entrance delay has elapsed', () => {
    const ctx = mockCtx();
    renderHalftoneFrame({
      ctx, particles, elapsedMs: 0, exitElapsedMs: null, reduceMotion: false,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    // At t=0 every particle's entrance progress is 0 (fully transparent) OR still negative
    // (not yet started, also fully transparent) — the renderer skips drawing calls below its own
    // opacity threshold, so stroke() should not have been called for every one of ~680 particles.
    expect((ctx.stroke as jest.Mock).mock.calls.length).toBeLessThan(particles.length);
  });

  it('draws every particle once fully assembled (entrance complete, not exiting)', () => {
    const ctx = mockCtx();
    const fullyAssembledMs = ENTRANCE_DURATION_MS + ENTRANCE_STAGGER_WINDOW_MS + 100;
    renderHalftoneFrame({
      ctx, particles, elapsedMs: fullyAssembledMs, exitElapsedMs: null, reduceMotion: false,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect((ctx.stroke as jest.Mock).mock.calls.length).toBe(particles.length);
  });

  it('reports exitComplete only once every particle has fully dispersed', () => {
    const ctx = mockCtx();
    const fullyAssembledMs = ENTRANCE_DURATION_MS + ENTRANCE_STAGGER_WINDOW_MS + 100;

    const midExit = renderHalftoneFrame({
      ctx, particles, elapsedMs: fullyAssembledMs, exitElapsedMs: 50, reduceMotion: false,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect(midExit.exitComplete).toBe(false);

    const fullyExitedMs = EXIT_DURATION_MS + EXIT_STAGGER_WINDOW_MS + 100;
    const doneExit = renderHalftoneFrame({
      ctx, particles, elapsedMs: fullyAssembledMs, exitElapsedMs: fullyExitedMs, reduceMotion: false,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect(doneExit.exitComplete).toBe(true);
  });

  it('reduced motion never draws once exiting has started, and reports exitComplete on that very first frame', () => {
    const ctx = mockCtx();
    const result = renderHalftoneFrame({
      ctx, particles, elapsedMs: 99999, exitElapsedMs: 0, reduceMotion: true,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect((ctx.stroke as jest.Mock).mock.calls.length).toBe(0);
    expect(result.exitComplete).toBe(true);
  });

  it('reduced motion draws the static final frame when not exiting', () => {
    const ctx = mockCtx();
    const result = renderHalftoneFrame({
      ctx, particles, elapsedMs: 0, exitElapsedMs: null, reduceMotion: true,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect((ctx.stroke as jest.Mock).mock.calls.length).toBe(particles.length);
    expect(result.exitComplete).toBe(false);
  });

  it('clears the canvas exactly once per frame', () => {
    const ctx = mockCtx();
    renderHalftoneFrame({
      ctx, particles, elapsedMs: 500, exitElapsedMs: null, reduceMotion: false,
      color: '#b5502e', canvasWidth: 400, canvasHeight: 300,
    });
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 300);
  });
});
