'use client';
import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import '@/styles/globals.css';
// Replaces the root layout when it fails, so it renders its own document.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en-GB">
      <body>
        <title>Something went wrong | Adolphus Group</title>
        <main id="main" className="inner-page">
          <section className="container legal-page">
            <p className="eyebrow">Unexpected error</p>
            <h1>
              Something
              <br />
              <em>went wrong.</em>
            </h1>
            <p className="feedback-error" role="alert">
              We couldn’t load this page. Please try again.
            </p>
            <button
              type="button"
              className="button button-dark"
              onClick={() => retry()}
            >
              Try again
            </button>{' '}
            <Link href="/" className="button button-outline">
              Back to home
            </Link>
          </section>
        </main>
      </body>
    </html>
  );
}
