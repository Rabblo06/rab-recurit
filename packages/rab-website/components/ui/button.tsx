import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
export function ButtonLink({
  href,
  children,
  variant = 'dark',
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: 'dark' | 'outline' | 'light';
  className?: string;
}) {
  return (
    <Link href={href} className={cn('button', `button-${variant}`, className)}>
      {children}
      <ArrowUpRight size={17} aria-hidden="true" />
    </Link>
  );
}
