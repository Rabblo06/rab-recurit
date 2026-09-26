'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { navigation } from '@/lib/site';
export function Sheet() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="menu-trigger" aria-label="Open navigation">
        <Menu size={23} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet-content">
          <Dialog.Title className="eyebrow">Adolphus Group</Dialog.Title>
          <Dialog.Description className="muted">
            People. Possibility. A personal connection.
          </Dialog.Description>
          <Dialog.Close className="sheet-close" aria-label="Close navigation">
            <X />
          </Dialog.Close>
          <nav aria-label="Mobile navigation">
            <Link href="/" onClick={() => setOpen(false)}>
              Home
            </Link>
            {navigation.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ))}
            <Link href="/contact" onClick={() => setOpen(false)}>
              Get in touch ↗
            </Link>
          </nav>
          <span className="eyebrow sheet-location">London, United Kingdom</span>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
