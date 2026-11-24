import { fireEvent, render, screen } from '@testing-library/react';
import RecordOpenAction from './RecordOpenAction';

it('opens the record once without triggering the surrounding row action', () => {
  const onOpen = jest.fn();
  const onRow = jest.fn();
  render(<table><tbody><tr onClick={onRow}><td><RecordOpenAction label="Open record" onOpen={onOpen}/></td></tr></tbody></table>);
  fireEvent.click(screen.getByRole('button', { name: 'Open record' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onRow).not.toHaveBeenCalled();
});
