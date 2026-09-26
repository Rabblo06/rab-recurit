import Link from 'next/link';
import { Wordmark } from '@/components/shared/floating-nav';
import { navigation, site } from '@/lib/site';
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <Wordmark />
            <p>Great people. New possibilities.</p>
          </div>
          <nav aria-label="Footer navigation">
            {navigation.map((item) => (
              <Link href={item.href} key={item.label}>
                {item.label}
              </Link>
            ))}
            <Link href="/contact">Contact</Link>
          </nav>
          <address>
            {site.address}
            <br />
            <a href={site.phoneHref}>{site.phone}</a>
          </address>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Adolphus Group</span>
          <span className="footer-location">
            <span className="status-dot" />
            London, United Kingdom
          </span>
          <nav aria-label="Legal">
            {['Privacy', 'Cookies', 'Terms'].map((label) => (
              <Link key={label} href={`/${label.toLowerCase()}`}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
