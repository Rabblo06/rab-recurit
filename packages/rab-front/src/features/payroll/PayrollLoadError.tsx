import { getApiErrorMessage, normalizeApiError } from '../../shared/lib/apiError';

/** The exact refusal `RequireWorkspaceGuard` returns when the session has no operational workspace. */
const NO_WORKSPACE_MESSAGE = /no private Workspace yet/i;

/**
 * Payroll's load-error state. The "no workspace" copy is shown ONLY when the server really said so (403 from the
 * workspace guard). Any other failure — including a 404 from an API that does not have this route yet — gets a neutral
 * message and Retry, never a misleading workspace explanation.
 */
export default function PayrollLoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const normalized = normalizeApiError(error);
  const raw = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (normalized.status === 403 && typeof raw === 'string' && NO_WORKSPACE_MESSAGE.test(raw)) {
    return (
      <div className="list-error" role="alert">
        <p className="feedback-error">No operational workspace is available for your account yet.</p>
        <p>Set up or join a workspace to see payroll. Your data has not been changed.</p>
      </div>
    );
  }
  const message = normalized.status === 403
    ? getApiErrorMessage(error)
    : "Payroll couldn't be loaded. Please try again.";
  return (
    <div className="list-error" role="alert">
      <p className="feedback-error">{message}</p>
      <p>Your data has not been changed.</p>
      {normalized.status !== 403 && <button type="button" className="btn btn-outline" onClick={retry}>Retry</button>}
    </div>
  );
}
