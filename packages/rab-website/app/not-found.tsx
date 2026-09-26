import { ButtonLink } from '@/components/ui/button';
export default function NotFound() {
  return (
    <main id="main" className="inner-page">
      <section className="container legal-page">
        <p className="eyebrow">404 / A different direction</p>
        <h1>
          Let’s get you
          <br />
          <em>back on track.</em>
        </h1>
        <p>We couldn’t find that page.</p>
        <ButtonLink href="/">Back to home</ButtonLink>
      </section>
    </main>
  );
}
