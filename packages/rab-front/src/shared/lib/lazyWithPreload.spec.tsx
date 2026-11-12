import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { importWithRetry, isChunkLoadError, lazyWithPreload, reloadOnceForNewBuild } from './lazyWithPreload';

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/Users-abc123.js');
const Page = () => <p>page loaded</p>;

describe('lazyWithPreload (fast first navigation)', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('recognises chunk-load errors and nothing else', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('retries a failed chunk import once, then recovers', async () => {
    const factory = jest.fn().mockRejectedValueOnce(chunkError()).mockResolvedValueOnce({ default: Page });
    const onReload = jest.fn(() => true);
    await expect(importWithRetry(factory, { retryDelayMs: 0, onReload })).resolves.toEqual({ default: Page });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('a route whose first import fails renders after the retry', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    const factory = jest.fn().mockRejectedValueOnce(chunkError()).mockResolvedValueOnce({ default: Page });
    const Lazy = lazyWithPreload(factory);
    render(<Suspense fallback={<p>loading</p>}><Lazy /></Suspense>);
    expect(screen.getByText('loading')).toBeTruthy();
    await jest.advanceTimersByTimeAsync(500);
    expect(await screen.findByText('page loaded')).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('a second chunk failure reloads the page once (the deploy removed the chunk)', async () => {
    const factory = jest.fn().mockRejectedValue(chunkError());
    const onReload = jest.fn(() => true);
    const pending = importWithRetry(factory, { retryDelayMs: 0, onReload });
    // Reloading: the import never settles (React stays suspended instead of flashing an error).
    const settled = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('never reloads in a loop: a second reload inside the window is refused and the error surfaces', async () => {
    const reload = jest.fn();
    let now = 1_000_000;
    expect(reloadOnceForNewBuild(() => now, reload)).toBe(true);
    now += 5_000;
    expect(reloadOnceForNewBuild(() => now, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    now += 60_000; // a later deploy, outside the window, may reload again
    expect(reloadOnceForNewBuild(() => now, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);

    const factory = jest.fn().mockRejectedValue(chunkError());
    await expect(importWithRetry(factory, { retryDelayMs: 0, onReload: () => false })).rejects.toThrow(/dynamically imported module/);
  });

  it('a non-chunk error is retried once and then thrown, never reloaded', async () => {
    const factory = jest.fn().mockRejectedValue(new Error('boom'));
    const onReload = jest.fn(() => true);
    await expect(importWithRetry(factory, { retryDelayMs: 0, onReload })).rejects.toThrow('boom');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(onReload).not.toHaveBeenCalled();
  });

  it('preload() downloads once and the route reuses it', async () => {
    const factory = jest.fn().mockResolvedValue({ default: Page });
    const Lazy = lazyWithPreload(factory);
    await Lazy.preload();
    await Lazy.preload();
    render(<Suspense fallback={<p>loading</p>}><Lazy /></Suspense>);
    expect(await screen.findByText('page loaded')).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('a failed background preload never reloads the page, and the route tries again', async () => {
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload: reloadSpy } });
    const factory = jest.fn()
      .mockRejectedValueOnce(chunkError())
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce({ default: Page });
    const Lazy = lazyWithPreload(factory);
    await expect(Lazy.preload()).rejects.toThrow();
    expect(reloadSpy).not.toHaveBeenCalled();
    render(<Suspense fallback={<p>loading</p>}><Lazy /></Suspense>);
    expect(await screen.findByText('page loaded')).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(3);
  });
});
