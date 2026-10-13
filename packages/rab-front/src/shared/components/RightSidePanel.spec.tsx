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
