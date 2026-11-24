import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconArrowUpRight, IconSparkles } from '@tabler/icons-react';
import { useAiChat } from '../ai/AiChatProvider';
import { useAiAvailability } from '../ai/useAiAvailability';
import { aiApi, aiKeys } from '../ai/aiApi';
import { aiBlockedMessage } from '../ai/AiStates';

const prompts = [
  ['list_unfilled_shifts', 'Which shifts still need staff?'],
  ['find_shifts', 'Which shifts begin in the next 24 hours?'],
  ['get_offer_status', 'Show accepted offers awaiting my confirmation.'],
  ['get_timesheet_approval_queue', 'Summarise timesheets that need review.'],
] as const;
/** Uses the existing session/workspace draft store. Opening chat never submits a question or a write. */
export default function UpNextComposer({ onSearch }: { onSearch?: () => void }) {
  const chat = useAiChat();
  const availability = useAiAvailability();
  const navigate = useNavigate();
  const capabilities = useQuery({
    queryKey: aiKeys.capabilities(chat.scope),
    queryFn: aiApi.capabilities,
    enabled: availability.usable,
    staleTime: 600000,
    retry: false,
    meta: { silent: true },
  });
  const open = () => {
    chat.setReturnTo('/up-next');
    chat.setPanelOpen(false);
    navigate('/chat');
  };
  if (!availability.eligible)
    return (
      <div className="up-next-assistant-unavailable">
        <span>
          {availability.isPending
            ? 'Checking assistant availability…'
            : availability.isError
              ? 'Assistant availability could not be checked.'
              : 'AI is unavailable for this account.'}
        </span>
        {availability.isError ? (
          <button className="btn btn-outline" onClick={() => void availability.refetch()}>
            Retry
          </button>
        ) : (
          onSearch && (
            <button className="btn btn-outline" onClick={onSearch}>
              Search workspace
            </button>
          )
        )}
      </div>
    );
  if (!availability.usable)
    return (
      <div className="up-next-assistant-unavailable">
        <span>
          {availability.data &&
          !availability.data.available &&
          (availability.data.reason === 'not_configured' || availability.data.reason === 'demo_data_only')
            ? aiBlockedMessage(availability.data)
            : 'AI is currently unavailable.'}
        </span>
        <button className="btn btn-outline" onClick={open}>
          Open assistant
        </button>
      </div>
    );
  const allowed = new Set(capabilities.data?.tools.map((tool) => tool.name) ?? []);
  return (
    <div className="up-next-ai">
      <div className="up-next-prompts">
        {prompts
          .filter(([tool]) => allowed.has(tool))
          .map(([tool, prompt]) => (
            <button
              key={tool}
              onClick={() => {
                chat.setDraft(prompt);
                open();
              }}
            >
              {prompt}
            </button>
          ))}
      </div>
      <form
        className="up-next-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (chat.draft.trim()) open();
        }}
      >
        <label htmlFor="up-next-question">
          <IconSparkles size={15} /> Ask Crewflow
        </label>
        <textarea
          id="up-next-question"
          rows={2}
          maxLength={availability.data?.limits?.maxInputChars}
          placeholder="Ask Crewflow about shifts, staffing or your priorities…"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (chat.draft.trim()) open();
            }
          }}
        />
        <div>
          <small>Continue in your assistant · Review before sending</small>
          <button type="submit" aria-label="Continue in AI chat" disabled={!chat.draft.trim()}>
            <IconArrowUpRight size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
