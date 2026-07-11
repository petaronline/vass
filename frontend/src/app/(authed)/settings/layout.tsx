'use client';

/**
 * Settings layout — sub-navigation on the left, content on the right.
 *
 * Some tabs are admin-only. We fetch /auth/me once to filter the list
 * client-side; the actual route protection lives on the backend, this is
 * just to keep the UI tidy.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Layers, User, Sliders, Image as ImageIcon, Share2, Boxes, Plug } from 'lucide-react';
import { auth } from '@/lib/api';

interface SubNavItem {
  label: string;
  href: string;
  icon: typeof Layers;
  adminOnly?: boolean;
}

const SUB_NAV: SubNavItem[] = [
  { label: 'Connections',      href: '/settings/connections',     icon: Plug },
  { label: 'Brands',           href: '/settings/brands',          icon: Boxes },
  { label: 'Ad accounts',      href: '/settings/ad-accounts',     icon: Layers },
  { label: 'Social profiles',  href: '/settings/social-profiles', icon: Share2 },
  { label: 'Launch defaults',  href: '/settings/launch-defaults', icon: Sliders },
  { label: 'Branding',         href: '/settings/branding',        icon: ImageIcon, adminOnly: true },
  { label: 'Profile',          href: '/settings/profile',         icon: User },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Fetch role once so we can filter admin-only tabs from the sub-nav.
  // Backend still enforces the actual permission — this is purely cosmetic.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    auth.me()
      .then((r) => !cancelled && setIsAdmin(r.user.role === 'admin'))
      .catch(() => { /* ignore — hide admin tabs */ });
    return () => { cancelled = true; };
  }, []);

  const tabs = SUB_NAV.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="h-page">Settings</h1>
        <p className="text-sm text-ink-muted mt-1">
          Configure how Vass connects to Meta and which ad accounts your team can launch into.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-8">
        {/* Sub-nav */}
        <aside>
          <nav>
            <ul className="space-y-0.5">
              {tabs.map((item) => {
                const isActive = pathname === item.href;
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={[
                        'flex items-center gap-3 px-3 py-2 rounded text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-accent-subtle text-accent'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                      ].join(' ')}
                    >
                      <Icon size={16} strokeWidth={2} />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Content */}
        <div>{children}</div>
      </div>
    </div>
  );
}
