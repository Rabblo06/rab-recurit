import { useState } from 'react';
import { EmptyState } from '../../shared/components/LoadingState';

/**
 * Wave 3 lane H — the two workspace-host states that replace the whole app. Both render from server-built, already
 * validated URLs only (`isSafeWorkspaceUrl`), and neither shows anything about the workspace this host belongs to.
 */

export function WorkspaceNotFoundScreen({ defaultUrl }: { defaultUrl: string | null }) {
  return (
    <main className="standalone-state-page">
      <EmptyState
        variant="notFound"
        title="Workspace not found"
        description="There is no workspace at this address. Check the address, or go to the main sign-in page."
        action={defaultUrl ? <a href={`${defaultUrl}/login`} className="btn btn-dark">Go to sign in</a> : undefined}
      />
    </main>
  );
}

/**
 * Shown when the signed-in account belongs to a different workspace than this host. No data is shown (the server
 * already refused every request with a 404). Offers the account's OWN workspace address, or signing out.
 */
export function WrongHostScreen({ ownUrl, onSignOut }: { ownUrl: string | null; onSignOut: () => Promise<void> }) {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <main className="standalone-state-page">
      <EmptyState
        variant="access"
        title="This workspace isn't available to your account"
        description="You're signed in to a different workspace. Go to your own workspace, or sign out to use another account here."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {ownUrl && (
              <a href={ownUrl} className="btn btn-dark">
                Go to your workspace
              </a>
            )}
            <button
              type="button"
              className="btn btn-outline"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                await onSignOut();
              }}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        }
      />
    </main>
  );
}
