import { render, fireEvent, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import Drawer from './Drawer';

/**
 * A stand-in for `DateInput`'s calendar / the generic `Popover` — both real
 * components render exactly this way: a `document.body` portal carrying
 * `data-rab-portal="true"`. Using a minimal stand-in here (rather than the
 * real `DateInput`) keeps this test focused on `Drawer`/`RightSidePanel`'s
 * own outside-click contract, not on calendar rendering.
 */
function PortaledButton({ onClick, label }: { onClick: () => void; label: string }) {
  return createPortal(
    <button data-rab-portal="true" onClick={onClick}>{label}</button>,
    document.body,
  );
}

describe('Drawer unsaved-changes guard', () => {
  // TEST 5 / TEST 6: picking a date (anything inside a `[data-rab-portal]`
  // element, e.g. DateInput's calendar or the generic Popover) must never
  // read as an outside click and must never surface the discard prompt —
  // this is the actual regression that was reported.
  it('does not show the discard prompt when a click lands inside a portaled popover', () => {
    render(
      <Drawer open onClose={jest.fn()} title="New staff member" dirty footer={<button>Create</button>}>
        <PortaledButton label="15" onClick={() => {}} />
      </Drawer>,
    );

    fireEvent.mouseDown(screen.getByText('15'));

    expect(screen.queryByText('You have unsaved changes. Discard them?')).not.toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument(); // drawer body still rendered, not replaced by the confirm screen
  });

  // TEST 7: a real outside click (nothing to do with a portaled popover)
  // on a dirty drawer must still show the discard prompt — the guard
  // itself must keep working, only the false positive is fixed.
  it('shows the discard prompt on a genuine outside click while dirty', () => {
    render(
      <Drawer open onClose={jest.fn()} title="New staff member" dirty footer={<button>Create</button>}>
        <input placeholder="First name" />
      </Drawer>,
    );

    fireEvent.mouseDown(document.body);

    expect(screen.getByText('You have unsaved changes. Discard them?')).toBeInTheDocument();
  });

  // TEST 8: "Keep editing" returns to the form with values untouched — the
  // drawer never called onClose, and the underlying content is still there.
  it('"Keep editing" dismisses the prompt and keeps the drawer open with its content intact', () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="New staff member" dirty footer={<button>Create</button>}>
        <input placeholder="First name" defaultValue="Jordan" />
      </Drawer>,
    );

    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByText('Keep editing'));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('First name')).toHaveValue('Jordan');
  });

  // TEST 9: "Discard changes" actually closes.
  it('"Discard changes" closes the drawer', () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="New staff member" dirty footer={<button>Create</button>}>
        <input placeholder="First name" />
      </Drawer>,
    );

    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByText('Discard changes'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes immediately on outside click when the drawer is not dirty', () => {
    const onClose = jest.fn();
    render(
      <Drawer open onClose={onClose} title="New staff member" footer={<button>Create</button>}>
        <input placeholder="First name" />
      </Drawer>,
    );

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
