import { Component, type ErrorInfo, type ReactNode } from 'react';
import { EmptyState } from './LoadingState';

export default class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled application error', error, info);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main className="standalone-state-page">
          <EmptyState
            variant="serverError"
            title="Something went wrong"
            description="The application could not display this page. Reload to try again."
            action={<button className="btn btn-dark" onClick={() => window.location.reload()}>Reload</button>}
          />
        </main>
      );
    }

    return this.props.children;
  }
}
