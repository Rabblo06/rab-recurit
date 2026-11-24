import { fireEvent, render, screen } from '@testing-library/react';
import RightSidePanel from './RightSidePanel';

it('preserves existing drawer unsaved-change interception for outside clicks and Escape', () => {
  const close = jest.fn(), guard = jest.fn(() => false);
  render(<RightSidePanel open onClose={close} requestClose={guard}><button>Inside</button></RightSidePanel>);
  fireEvent.mouseDown(document.body);
  fireEvent.keyDown(screen.getByText('Inside'), { key: 'Escape' });
  expect(guard).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
});

it('lets a contextual dock coexist with page clicks and limits Escape to its own focused content', () => {
  const close = jest.fn();
  render(<RightSidePanel open persistent onClose={close}><button>Inside</button></RightSidePanel>);
  fireEvent.mouseDown(document.body);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByText('Inside'), { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps portaled date/popover clicks inside the existing drawer guard boundary', () => {
  const close = jest.fn();
  render(<><RightSidePanel open onClose={close}><button>Inside</button></RightSidePanel><div data-rab-portal><button>Calendar date</button></div></>);
  fireEvent.mouseDown(screen.getByText('Calendar date'));
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.body);
  expect(close).toHaveBeenCalledTimes(1);
});

it('adapts an open drawer when the viewport changes without losing form state', () => {
  const original = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  const { container } = render(<RightSidePanel open onClose={jest.fn()} width={408}><input aria-label="Draft" defaultValue="Keep this" /></RightSidePanel>);
  expect(container.querySelector('.side-panel-dock')).toHaveAttribute('data-layout', 'docked');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  fireEvent(window, new Event('resize'));
  expect(container.querySelector('.side-panel-dock')).toHaveAttribute('data-layout', 'overlay');
  expect(container.querySelector('.side-panel')).toHaveStyle({ width: '390px' });
  expect(screen.getByLabelText('Draft')).toHaveValue('Keep this');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  fireEvent(window, new Event('resize'));
  expect(container.querySelector('.side-panel-dock')).toHaveAttribute('data-layout', 'docked');
  expect(container.querySelector('.side-panel')).toHaveStyle({ width: '408px' });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
});
