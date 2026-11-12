import { act, render, screen } from '@testing-library/react';
import { DelayedFallback } from './RouteFallback';
import { settingsContentKey } from '../../features/settings/layout/settingsContentKey';

describe('route fallbacks (fast first navigation)', () => {
  afterEach(() => jest.useRealTimers());

  it('shows nothing for the first 150 ms, then the skeleton (no flash on a preloaded page)', () => {
    jest.useFakeTimers();
    render(<DelayedFallback><p>skeleton</p></DelayedFallback>);
    expect(screen.queryByText('skeleton')).toBeNull();
    act(() => { jest.advanceTimersByTime(149); });
    expect(screen.queryByText('skeleton')).toBeNull();
    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.getByText('skeleton')).toBeTruthy();
  });

  it('settings pages each get their own boundary, but the role editor keeps ONE across its steps (its unsaved draft survives)', () => {
    expect(settingsContentKey('/settings/profile')).toBe('/settings/profile');
    expect(settingsContentKey('/settings/workspace/members')).toBe('/settings/workspace/members');
    const editor = settingsContentKey('/settings/workspace/members/roles/r-1');
    expect(settingsContentKey('/settings/workspace/members/roles/r-1/objects')).toBe(editor);
    expect(settingsContentKey('/settings/workspace/members/roles/r-1/objects/shift')).toBe(editor);
    expect(settingsContentKey('/settings/workspace/members/roles/r-2')).not.toBe(editor);
  });
});
