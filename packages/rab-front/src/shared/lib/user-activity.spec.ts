import { BACKGROUND_AFTER_MS, installUserActivityTracking, isBackgroundRequest, noteUserActivity } from './user-activity';

it('a request soon after real input is user activity; one after a long silence is background (CF-20)', () => {
  noteUserActivity(1_000_000);
  expect(isBackgroundRequest(1_000_000 + 5_000)).toBe(false);
  expect(isBackgroundRequest(1_000_000 + BACKGROUND_AFTER_MS + 1)).toBe(true);
});

it('pointer and keyboard input count as activity (listeners installed once, capture phase)', () => {
  const listeners: Record<string, () => void> = {};
  const target = { addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } } as unknown as Window;
  installUserActivityTracking(target);
  noteUserActivity(0);
  expect(isBackgroundRequest(Date.now())).toBe(true);
  listeners.keydown?.();
  expect(isBackgroundRequest(Date.now())).toBe(false);
});
