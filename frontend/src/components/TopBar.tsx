'use client';

/**
 * Top bar — search, notifications, user menu with logout.
 */
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ChevronDown, LogOut } from 'lucide-react';
import { auth, CurrentUser } from '@/lib/api';
import { BrandSelector } from './BrandSelector';
import { NotificationsBell } from './NotificationsBell';

export function TopBar({ user }: { user: CurrentUser }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function handleLogout() {
    try {
      await auth.logout();
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <header
      className={[
        'h-16 px-8 flex items-center justify-between sticky top-0 z-30',
        // Translucent + backdrop blur so the page tint shows through.
        // No solid background — the soft app gradient does the heavy lifting.
        'bg-white/55 backdrop-blur-card border-b border-white/60',
      ].join(' ')}
    >
      {/* Search */}
      <div className="relative max-w-md flex-1">
        <Search
          size={16}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none"
        />
        <input
          type="search"
          placeholder="Search ad sets, templates, batches…"
          className="w-full pl-10 pr-3 py-2 text-sm bg-white/60 border border-white/60 rounded-full
                     placeholder:text-ink-subtle focus:bg-white focus:border-accent
                     focus:ring-2 focus:ring-accent/15 focus:outline-none transition-colors"
        />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 ml-6">
        {/* Active brand selector — only renders on /organic/* */}
        <BrandSelector />

        <NotificationsBell />

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded hover:bg-white/55 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-accent-subtle text-accent flex items-center justify-center text-xs font-semibold">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <ChevronDown size={14} className="text-ink-muted" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-surface border border-line rounded-lg shadow-lift py-1.5 animate-fade-in">
              <div className="px-3 py-2 border-b border-line">
                <div className="text-sm font-medium text-ink truncate">{user.name}</div>
                <div className="text-xs text-ink-subtle truncate">{user.email}</div>
                <div className="text-xs text-accent mt-1 capitalize">{user.role}</div>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface-hover transition-colors"
              >
                <LogOut size={14} className="text-ink-muted" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
