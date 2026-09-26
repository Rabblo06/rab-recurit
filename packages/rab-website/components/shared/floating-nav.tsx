import Link from 'next/link';
import { navigation } from '@/lib/site';
import { ButtonLink } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
export function Wordmark() {
  return (
    <Link className="wordmark" href="/" aria-label="Adolphus Group home">
      <span className="monogram" aria-hidden="true">
        a<span>.</span>
      </span>
      <span>
        ADOLPHUS<small>G R O U P</small>
      </span>
    </Link>
  );
}
export function FloatingNav() {
  return (
    <header className="site-header">
      <div className="nav-wrap">
        <Wordmark />
        <nav className="nav-pill" aria-label="Main navigation">
          {navigation.map((item) => (
            <Link href={item.href} key={item.label}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="desktop-cta">
          <ButtonLink href="/contact">Let’s talk</ButtonLink>
        </div>
        <Sheet />
      </div>
    </header>
  );
}
