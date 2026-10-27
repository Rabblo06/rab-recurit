import { act, fireEvent, render, screen } from '@testing-library/react';
import { AiChatProvider, useAiChat } from './AiChatProvider';
import { applyIdentityFromServer, markAuthenticated, markUnauthenticated } from '../../shared/lib/auth-session';

function Probe() {
  const chat = useAiChat();
  return <><input aria-label="Draft" value={chat.draft} onChange={e => chat.setDraft(e.target.value)}/>
    <button onClick={chat.newChat}>New</button><button onClick={() => chat.setPanelOpen(!chat.panelOpen)}>Toggle panel</button>
    <button onClick={() => chat.selectConversation('conv-1')}>Open conv-1</button>
    <button onClick={() => chat.adoptNewDraft('conv-2')}>Server created conv-2</button>
    <output data-testid="panel">{String(chat.panelOpen)}</output>
    <output data-testid="conversation">{chat.conversationId ?? 'none'}</output>
    <output data-testid="scope">{chat.scope}</output></>;
}
const jwt = (sub: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, sid: 'session-a' })).toString('base64url')}.`;
beforeEach(() => { markUnauthenticated(); applyIdentityFromServer({ userId: 'a', sessionId: 'session-a' }); });
afterEach(() => act(() => markUnauthenticated()));

it('keeps one draft per conversation across page/panel changes and moves the new-chat draft onto the created conversation', () => {
  render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'First question' } });
  fireEvent.click(screen.getByText('Toggle panel'));
  expect(screen.getByLabelText('Draft')).toHaveValue('First question');
  fireEvent.click(screen.getByText('Open conv-1'));
  expect(screen.getByTestId('conversation')).toHaveTextContent('conv-1');
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Follow-up' } });
  fireEvent.click(screen.getByText('New'));
  expect(screen.getByLabelText('Draft')).toHaveValue('First question');
  fireEvent.click(screen.getByText('Server created conv-2'));
  expect(screen.getByTestId('conversation')).toHaveTextContent('conv-2');
  expect(screen.getByLabelText('Draft')).toHaveValue('First question');
  fireEvent.click(screen.getByText('New'));
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  fireEvent.click(screen.getByText('Open conv-1'));
  expect(screen.getByLabelText('Draft')).toHaveValue('Follow-up');
});

it.each(['logout', 'user', 'same-user-login', 'session'] as const)('discards drafts, the open conversation and panel state on %s (and changes the query scope)', transition => {
  render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  const scopeBefore = screen.getByTestId('scope').textContent;
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Private draft' } });
  fireEvent.click(screen.getByText('Open conv-1'));
  fireEvent.click(screen.getByText('Toggle panel'));
  act(() => {
    if (transition === 'logout') markUnauthenticated();
    else if (transition === 'same-user-login') markAuthenticated(jwt('a'));
    else applyIdentityFromServer({ userId: transition === 'user' ? 'b' : 'a', sessionId: 'session-b' });
  });
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  expect(screen.getByTestId('conversation')).toHaveTextContent('none');
  expect(screen.getByTestId('panel')).toHaveTextContent('false');
  expect(screen.getByTestId('scope').textContent).not.toBe(scopeBefore);
});

it('discards drafts on workspace changes and never restores them when switching back', () => {
  const { rerender } = render(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Workspace A only' } });
  rerender(<AiChatProvider workspaceId="b"><Probe/></AiChatProvider>);
  expect(screen.getByLabelText('Draft')).toHaveValue('');
  rerender(<AiChatProvider workspaceId="a"><Probe/></AiChatProvider>);
  expect(screen.getByLabelText('Draft')).toHaveValue('');
});
