import { Link } from 'react-router-dom';
import { EmptyState } from '../../shared/components/LoadingState';

export default function NotFound() {
  return (
    <main className="standalone-state-page">
      <EmptyState
        variant="notFound"
        title="Page not found"
        description="The page may have moved or the address may be incorrect."
        action={<Link to="/" className="btn btn-dark">Go to dashboard</Link>}
      />
    </main>
  );
}
