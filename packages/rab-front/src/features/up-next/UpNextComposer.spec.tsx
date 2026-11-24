import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AiChatProvider, useAiChat } from '../ai/AiChatProvider';
import UpNextComposer from './UpNextComposer';
jest.mock('../ai/useAiAvailability', () => ({ useAiAvailability: () => mockAvailability }));
jest.mock('../ai/aiApi', () => ({
  aiKeys: { capabilities: (scope: string) => ['ai', scope, 'capabilities'] },
  aiApi: { capabilities: async () => ({ tools: [{ name: 'find_shifts' }] }) },
}));
let mockAvailability: any;
function Chat() {
  const chat = useAiChat();
  return <p>Draft: {chat.draft}</p>;
}
function setup() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AiChatProvider workspaceId="test">
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<UpNextComposer />} />
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </MemoryRouter>
      </AiChatProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mockAvailability = {
    usable: true,
    eligible: true,
    data: { available: true, limits: { maxInputChars: 4000 } },
    isPending: false,
    isError: false,
  };
});
test('carries an unsent draft into the existing chat state', () => {
  setup();
  fireEvent.change(screen.getByLabelText('Ask Crewflow'), { target: { value: 'Review my staffing gaps' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue in AI chat' }));
  expect(screen.getByText('Draft: Review my staffing gaps')).toBeInTheDocument();
});
test('suggestions expose only tools returned by the existing capabilities service', async () => {
  setup();
  expect(
    await screen.findByRole('button', { name: 'Which shifts begin in the next 24 hours?' }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Which shifts still need staff?' })).not.toBeInTheDocument();
});
test('feature-disabled AI has no editable composer', () => {
  mockAvailability = {
    ...mockAvailability,
    usable: false,
    eligible: false,
    data: { available: false, reason: 'feature_disabled' },
  };
  setup();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText('AI is unavailable for this account.')).toBeInTheDocument();
});
