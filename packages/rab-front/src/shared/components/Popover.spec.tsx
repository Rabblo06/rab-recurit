import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import Popover from './Popover';

/**
 * The anchor can move without any scroll/resize event and without the popover resizing — in the AI chat, tagging the
 * first skill adds a chip row to the vertically centred composer, which pushes the "Tag a skill" button down while its
 * menu is open. The popover must follow the anchor instead of staying at its old position over its own trigger.
 */
function Harness() {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchorRef}>Tag a skill</button>
      <Popover open onClose={() => {}} anchorRef={anchorRef} animated={false}>
        <div>menu</div>
      </Popover>
    </>
  );
}

const rectAt = (top: number) => ({ top, bottom: top + 30, left: 100, right: 220, width: 120, height: 30, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;

describe('Popover anchor tracking', () => {
  let anchorTop = 200;
  let frames: FrameRequestCallback[] = [];
  const runFrame = () => act(() => { const due = frames; frames = []; due.forEach((cb) => cb(performance.now())); });

  beforeEach(() => {
    anchorTop = 200;
    frames = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.textContent === 'Tag a skill' ? rectAt(anchorTop) : rectAt(0);
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  });
  afterEach(() => jest.restoreAllMocks());

  it('moves with its anchor when the page layout shifts it, with no scroll or resize event', () => {
    render(<Harness />);
    runFrame();
    const panel = screen.getByText('menu').parentElement as HTMLElement;
    expect(panel.style.top).toBe('234px'); // anchor bottom 230 + 4

    anchorTop = 211; // a chip row above the anchor pushed it down 11 px
    runFrame();
    expect(panel.style.top).toBe('245px');
  });
});
