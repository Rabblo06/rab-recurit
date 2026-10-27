import { fireEvent, render, screen } from '@testing-library/react';
import ChatComposer from './ChatComposer';
import ChatBody from './ChatBody';
import { ChatActivity, ChatApproval, ChatQuestion, ChatQueue } from './ChatComponents';

it('sends only appropriate Enter keystrokes and preserves the draft for the caller', () => {
  const send = jest.fn();
  render(<ChatComposer value="Draft" onChange={jest.fn()} onSend={send}/>);
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue('Draft');
});

it.each(['unavailable', 'disabled', 'sending'] as const)('blocks send when %s', state => {
  const send = jest.fn();
  render(<ChatComposer value="Draft" onChange={jest.fn()} onSend={send} {...{ [state]: true }}/>);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('Draft');
});

it('supports stop, error retry and only caller-provided model choices', () => {
  const stop = jest.fn(), send = jest.fn(), choose = jest.fn();
  const { rerender } = render(<ChatComposer value="Retry me" onChange={jest.fn()} onSend={send} sending onStop={stop}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
  expect(stop).toHaveBeenCalledTimes(1);
  rerender(<ChatComposer value="Retry me" onChange={jest.fn()} onSend={send} error="Service unavailable" models={['Provided A', 'Provided B']} model="Provided A" onModelChange={choose}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable');
  expect(screen.getByRole('textbox')).toHaveValue('Retry me');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Provided B' } });
  expect(choose).toHaveBeenCalledWith('Provided B');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps the same focused composer when the empty state becomes a conversation', () => {
  const change = jest.fn();
  const { rerender } = render(<ChatBody surface="page" value="Retained" onChange={change}/>);
  const input = screen.getByRole('textbox');
  fireEvent.click(screen.getByText('Which shifts this weekend are unfilled?'));
  expect(change).toHaveBeenCalledWith('Which shifts this weekend are unfilled?');
  expect(input).toHaveFocus();
  rerender(<ChatBody surface="page" value="Retained" onChange={change} hasMessages messages={<p>Isolated response fixture</p>}/>);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Retained');
});

it('requires an explicit selected-record approval callback and never fakes completion', () => {
  const approve = jest.fn();
  const records = [{ id: 'a', label: 'Fixture A' }, { id: 'b', label: 'Fixture B' }];
  const { rerender } = render(<ChatApproval title="Review" description="Fixture only" records={records}/>);
  expect(screen.getByRole('button', { name: 'Approve selection' })).toBeDisabled();
  rerender(<ChatApproval title="Review" description="Fixture only" records={records} onApprove={approve}/>);
  fireEvent.click(screen.getByLabelText('Fixture B'));
  expect(approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Approve selection' }));
  expect(approve).toHaveBeenCalledWith(['a']);
  expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  rerender(<ChatApproval title="Review" description="Updated proposal" records={[{ id: 'new', label: 'New fixture' }]} onApprove={approve}/>);
  expect(screen.getByRole('button', { name: 'Approve selection' })).toBeDisabled();
});

it('opens activity details and sends question/queue actions only to explicit callbacks', () => {
  const answer = jest.fn(), edit = jest.fn(), cancel = jest.fn();
  render(<><ChatActivity title="Fixture tool" status="complete">Fixture result</ChatActivity>
    <ChatQuestion question="Choose scope" options={['Today', 'Tomorrow']} onAnswer={answer}/>
    <ChatQueue items={[{ id: 'queued', text: 'Fixture request' }]} onEdit={edit} onCancel={cancel}/></>);
  expect(screen.queryByText('Fixture result')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Fixture tool/ }));
  expect(screen.getByText('Fixture result')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Tomorrow'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(answer).toHaveBeenCalledWith('Tomorrow');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Fixture request' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Fixture request' }));
  expect(edit).toHaveBeenCalledWith('queued');
  expect(cancel).toHaveBeenCalledWith('queued');
});
