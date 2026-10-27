import AiChatPanel from './AiChatPanel';

/** `/chat` — the full-page AI chat. Its history list is in the shell sidebar (`AiChatNavigation`). */
export default function AiChatPage() {
  return <AiChatPanel surface="page" />;
}
