import { act, fireEvent, render, screen } from '@testing-library/react';
import { AiChatProvider, useAiChat } from './AiChatProvider';
import { applyIdentityFromServer, markAuthenticated, markUnauthenticated } from '../../shared/lib/auth-session';

function Probe() {
  const chat = useAiChat();
  return <><input aria-label="Draft" value={chat.current.text} onChange={e => chat.setDraft(e.target.value)}/>
    <button onClick={chat.newChat}>New</button><button onClick={() => chat.setPanelOpen(!chat.panelOpen)}>Toggle panel</button>
    <output data-testid="panel">{String(chat.panelOpen)}</output>
    {chat.drafts.map(draft => <button key={draft.id} onClick={() => chat.selectDraft(draft.id)}>{draft.text}</button>)}</>;
}
const jwt = (sub: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, sid: 'session-a' })).toString('base64url')}.`;
beforeEach(() => { markUnauthenticated(); applyIdentityFromServer({ userId: 'a', sessionId: 'session-a' }); });
afterEach(() => act(() => markUnauthenticated()));

it('keeps one selected draft while page/panel presentation changes and restores unsent drafts', () => {
  render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'First draft' } });
  fireEvent.click(screen.getByText('Toggle panel'));
  expect(screen.getByLabelText('Draft')).toHaveValue('First draft');
  fireEvent.click(screen.getByText('New'));
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Second draft' } });
  fireEvent.click(screen.getByText('First draft'));
  expect(screen.getByLabelText('Draft')).toHaveValue('First draft');
  fireEvent.click(screen.getByText('Second draft'));
  expect(screen.getByLabelText('Draft')).toHaveValue('Second draft');
});

it.each(['logout', 'user', 'same-user-login', 'session'] as const)('discards drafts and panel state on %s', transition => {
  render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Private draft' } });
  fireEvent.click(screen.getByText('New'));
  fireEvent.click(screen.getByText('Toggle panel'));
  act(() => {
    if (transition === 'logout') markUnauthenticated();
    else if (transition === 'same-user-login') markAuthenticated(jwt('a'));
    else applyIdentityFromServer({ userId: transition === 'user' ? 'b' : 'a', sessionId: 'session-b' });
  });
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  expect(screen.queryByText('Private draft')).not.toBeInTheDocument();
  expect(screen.getByTestId('panel')).toHaveTextContent('false');
});

it('discards drafts on workspace changes and never restores them when switching back', () => {
  const { rerender } = render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Workspace A only' } });
  rerender(<AiChatProvider workspaceId="b"><Probe/></AiChatProvider>);
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  rerender(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  expect(screen.getByLabelText('Draft')).toHaveValue('');
});
